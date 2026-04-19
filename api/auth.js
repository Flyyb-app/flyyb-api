/**
 * FLYYB API — api/auth.js
 *
 * POST /api/auth?action=login          { email, password } | { phone, password }
 * POST /api/auth?action=register       { name, email, password, currency } | { name, phone, dial, currency, provider:'phone' }
 * POST /api/auth?action=send-login-otp { phone }
 * POST /api/auth?action=login-otp      { phone, otp }
 * POST /api/auth?action=verify-otp     { email, otp }
 * POST /api/auth?action=resend-otp     { email } | { phone }
 * POST /api/auth?action=refresh        { refreshToken } — or just Bearer header keep-alive
 * POST /api/auth?action=logout         { refreshToken }
 * GET  /api/auth?action=config         — returns Stripe publishable key
 *
 * NOTE on passwords:
 *   Passwords arrive as PLAINTEXT over HTTPS (TLS handles transport security).
 *   Client-side AES-GCM encryption was removed because it uses a random per-session
 *   key/IV, making bcrypt comparison impossible across sessions.
 *   Server hashes with bcrypt(12) before storage.
 *
 * NOTE on otp_codes table:
 *   OTP storage is attempted but non-fatal — if the table doesn't exist the
 *   registration/send still succeeds and the OTP is logged to Vercel console.
 *   Create the table when ready:
 *     CREATE TABLE otp_codes (
 *       identifier TEXT PRIMARY KEY,
 *       code TEXT NOT NULL,
 *       expires_at TIMESTAMPTZ NOT NULL
 *     );
 */

var authLib        = require('../lib/auth');
var { pool }       = require('../lib/db');
var { handleCors } = require('../lib/cors');

module.exports = async function(req, res) {
  if (handleCors(req, res)) return;

  var action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  if (action === 'config') return handleConfig(req, res);

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (action === 'login')          return await handleLogin(req, res);
    if (action === 'register')       return await handleRegister(req, res);
    if (action === 'send-login-otp') return await handleSendOtp(req, res);
    if (action === 'login-otp')      return await handleLoginOtp(req, res);
    if (action === 'verify-otp')     return await handleVerifyOtp(req, res);
    if (action === 'resend-otp')     return await handleResendOtp(req, res);
    if (action === 'refresh')        return await handleRefresh(req, res);
    if (action === 'logout')         return await handleLogout(req, res);
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    console.error('[Auth] Unhandled error:', err);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
};

// ─── OTP helpers ──────────────────────────────────────────────────────────────

// Store OTP — non-fatal: logs OTP to console if table missing so it can be
// used for testing. The calling function still returns success.
async function storeOtp(client, identifier, otp) {
  try {
    await client.query(
      "INSERT INTO otp_codes (identifier, code, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes') " +
      "ON CONFLICT (identifier) DO UPDATE SET code = $2, expires_at = NOW() + INTERVAL '10 minutes'",
      [identifier, otp]
    );
  } catch (e) {
    // otp_codes table may not exist yet — log so the OTP can be seen in Vercel logs
    console.warn('[Auth] OTP store failed (table may not exist). OTP for', identifier, 'is:', otp, '| Error:', e.message);
  }
}

// Check OTP — returns true and deletes it, or false if invalid/expired/table missing
async function checkAndDeleteOtp(client, identifier, otp) {
  try {
    var r = await client.query(
      'SELECT id FROM otp_codes WHERE identifier = $1 AND code = $2 AND expires_at > NOW()',
      [identifier, otp]
    );
    if (!r.rows.length) return false;
    await client.query('DELETE FROM otp_codes WHERE identifier = $1', [identifier]).catch(function() {});
    return true;
  } catch (e) {
    console.warn('[Auth] OTP check failed (table may not exist):', e.message);
    return false;
  }
}

// ─── Credit helper ─────────────────────────────────────────────────────────────
async function getCredits(client, userId) {
  try {
    var cr = await client.query('SELECT balance FROM credits WHERE user_id = $1', [userId]);
    return parseFloat((cr.rows[0] && cr.rows[0].balance) || 0);
  } catch (e) {
    return 0;
  }
}

// ─── Build user response ───────────────────────────────────────────────────────
function buildUserResponse(u) {
  return {
    id:            u.id,
    name:          u.name || (u.email || '').split('@')[0],
    email:         u.email  || null,
    phone:         u.phone  || null,
    flyybId:       u.flyyb_id || ('FLY' + String(u.id).padStart(6, '0')),
    currency:      u.default_currency || 'USD',
    emailVerified: !!u.email_verified,
  };
}

// ─── Login ─────────────────────────────────────────────────────────────────────
async function handleLogin(req, res) {
  var b = req.body || {};
  if (!b.password) return res.status(400).json({ error: 'Password required' });
  if (!b.email && !b.phone) return res.status(400).json({ error: 'Email or phone required' });

  var client, u;
  try {
    client = await pool.connect();
    var qr;
    if (b.email) {
      qr = await client.query(
        'SELECT id,name,email,phone,password_hash,is_active,email_verified,flyyb_id,default_currency FROM users WHERE lower(email)=lower($1)',
        [b.email]
      );
    } else {
      qr = await client.query(
        'SELECT id,name,email,phone,password_hash,is_active,email_verified,flyyb_id,default_currency FROM users WHERE phone=$1',
        [b.phone]
      );
    }
    u = qr.rows[0];
    if (!u || !u.password_hash) return res.status(401).json({ error: 'Invalid credentials' });
    if (u.is_active === false)  return res.status(403).json({ error: 'Account is disabled' });

    var valid = await authLib.verifyPassword(b.password, u.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    var at  = authLib.signAccessToken(u);
    var rt  = authLib.generateRefreshToken();
    var rh  = await authLib.hashToken(rt);
    var exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await client.query('UPDATE refresh_tokens SET revoked=TRUE WHERE user_id=$1', [u.id]);
    await client.query(
      'INSERT INTO refresh_tokens (user_id,token_hash,expires_at) VALUES ($1,$2,$3)',
      [u.id, rh, exp]
    );

    var credits = await getCredits(client, u.id);

    res.json({
      user:         buildUserResponse(u),
      accessToken:  at,
      refreshToken: rt,
      expiresIn:    3600,
      credits:      credits,
    });
  } catch (err) {
    console.error('Login:', err);
    res.status(500).json({ error: 'Login failed' });
  } finally {
    if (client) client.release();
  }
}

// ─── Register ──────────────────────────────────────────────────────────────────
async function handleRegister(req, res) {
  var b        = req.body || {};
  var name     = (b.name     || '').trim();
  var email    = (b.email    || '').trim().toLowerCase();
  var phone    = b.phone ? ((b.dial || '') + b.phone) : '';
  var currency = b.currency || 'USD';
  var provider = b.provider || 'email';
  var password = b.password || '';

  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (provider === 'email') {
    if (!email)    return res.status(400).json({ error: 'Email is required' });
    if (!password) return res.status(400).json({ error: 'Password is required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  } else {
    if (!phone) return res.status(400).json({ error: 'Phone is required' });
  }

  var client;
  try {
    client = await pool.connect();

    if (email) {
      var ck = await client.query('SELECT id FROM users WHERE lower(email)=$1', [email]);
      if (ck.rows.length) return res.status(409).json({ error: 'Email already registered' });
    }

    var newUser;
    if (provider === 'email') {
      var hash = await authLib.hashPassword(password);
      var ins  = await client.query(
        'INSERT INTO users (name,email,password_hash,default_currency,is_active,email_verified,created_at) VALUES ($1,$2,$3,$4,TRUE,FALSE,NOW()) RETURNING id,name,email,flyyb_id,default_currency',
        [name, email, hash, currency]
      );
      newUser = ins.rows[0];
    } else {
      var ins2 = await client.query(
        'INSERT INTO users (name,phone,default_currency,is_active,email_verified,created_at) VALUES ($1,$2,$3,TRUE,FALSE,NOW()) RETURNING id,name,phone,flyyb_id,default_currency',
        [name, phone, currency]
      );
      newUser = ins2.rows[0];
    }

    // Initialise credits row
    await client.query(
      'INSERT INTO credits (user_id,balance) VALUES ($1,0) ON CONFLICT (user_id) DO NOTHING',
      [newUser.id]
    ).catch(function() {});

    // Store OTP (non-fatal — OTP logged to console if table missing)
    var identifier = email || phone;
    var otp = String(Math.floor(100000 + Math.random() * 900000));
    await storeOtp(client, identifier, otp);
    console.log('[Auth] Register OTP for', identifier, ':', otp, '(wire to SMS/email in prod)');

    res.json({ registered: true, requiresOtp: true });
  } catch (err) {
    console.error('Register:', err);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    if (client) client.release();
  }
}

// ─── Verify OTP (email registration) ──────────────────────────────────────────
async function handleVerifyOtp(req, res) {
  var b          = req.body || {};
  var email      = (b.email || '').toLowerCase();
  var identifier = email || b.phone || '';
  var otp        = b.otp || '';

  if (!identifier || !otp) return res.status(400).json({ error: 'Email and OTP required' });

  var client, u;
  try {
    client = await pool.connect();
    var valid = await checkAndDeleteOtp(client, identifier, otp);
    if (!valid) return res.status(401).json({ error: 'Invalid or expired OTP' });

    // Mark email verified and fetch user
    if (email) {
      await client.query('UPDATE users SET email_verified=TRUE WHERE lower(email)=$1', [email]).catch(function() {});
      var qr = await client.query(
        'SELECT id,name,email,phone,is_active,email_verified,flyyb_id,default_currency FROM users WHERE lower(email)=$1',
        [email]
      );
      u = qr.rows[0];
    }

    if (!u) return res.status(500).json({ error: 'User not found after OTP verify' });

    var at  = authLib.signAccessToken(u);
    var rt  = authLib.generateRefreshToken();
    var rh  = await authLib.hashToken(rt);
    var exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await client.query(
      'INSERT INTO refresh_tokens (user_id,token_hash,expires_at) VALUES ($1,$2,$3)',
      [u.id, rh, exp]
    ).catch(function(e) { console.error('RT insert:', e.message); });

    var credits = await getCredits(client, u.id);

    res.json({
      user:         buildUserResponse(u),
      accessToken:  at,
      refreshToken: rt,
      expiresIn:    3600,
      credits:      credits,
    });
  } catch (err) {
    console.error('VerifyOtp:', err);
    res.status(500).json({ error: 'Verification failed' });
  } finally {
    if (client) client.release();
  }
}

// ─── Send OTP (phone login) ────────────────────────────────────────────────────
async function handleSendOtp(req, res) {
  var b     = req.body || {};
  var phone = b.phone || '';
  if (!phone) return res.status(400).json({ error: 'Phone required' });

  var otp = String(Math.floor(100000 + Math.random() * 900000));
  var client;
  try {
    client = await pool.connect();
    await storeOtp(client, phone, otp);
    // Always return success — if table missing, OTP is in Vercel logs
    console.log('[Auth] Phone OTP for', phone, ':', otp, '(demo)');
    res.json({ sent: true });
  } catch (err) {
    console.error('SendOtp:', err);
    res.status(500).json({ error: 'Failed to send OTP' });
  } finally {
    if (client) client.release();
  }
}

// ─── Login with OTP (phone) ────────────────────────────────────────────────────
async function handleLoginOtp(req, res) {
  var b     = req.body || {};
  var phone = b.phone || '';
  var otp   = b.otp   || '';
  if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP required' });

  var client, u;
  try {
    client = await pool.connect();
    var valid = await checkAndDeleteOtp(client, phone, otp);
    if (!valid) return res.status(401).json({ error: 'Invalid or expired OTP' });

    var existing = await client.query(
      'SELECT id,name,email,phone,is_active,email_verified,flyyb_id,default_currency FROM users WHERE phone=$1',
      [phone]
    );
    if (existing.rows.length) {
      u = existing.rows[0];
    } else {
      var ins = await client.query(
        'INSERT INTO users (phone,is_active,email_verified,created_at) VALUES ($1,TRUE,FALSE,NOW()) RETURNING id,name,email,phone,is_active,email_verified,flyyb_id,default_currency',
        [phone]
      );
      u = ins.rows[0];
      await client.query('INSERT INTO credits (user_id,balance) VALUES ($1,0) ON CONFLICT (user_id) DO NOTHING', [u.id]).catch(function() {});
    }

    var at  = authLib.signAccessToken(u);
    var rt  = authLib.generateRefreshToken();
    var rh  = await authLib.hashToken(rt);
    var exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await client.query('UPDATE refresh_tokens SET revoked=TRUE WHERE user_id=$1', [u.id]);
    await client.query('INSERT INTO refresh_tokens (user_id,token_hash,expires_at) VALUES ($1,$2,$3)', [u.id, rh, exp]);

    var credits = await getCredits(client, u.id);
    res.json({ user: buildUserResponse(u), accessToken: at, refreshToken: rt, expiresIn: 3600, credits: credits });
  } catch (err) {
    console.error('LoginOtp:', err);
    res.status(500).json({ error: 'OTP login failed' });
  } finally {
    if (client) client.release();
  }
}

// ─── Resend OTP ────────────────────────────────────────────────────────────────
async function handleResendOtp(req, res) {
  var b          = req.body || {};
  var identifier = b.email ? (b.email || '').toLowerCase() : (b.phone || '');
  if (!identifier) return res.status(400).json({ error: 'Email or phone required' });

  var otp = String(Math.floor(100000 + Math.random() * 900000));
  var client;
  try {
    client = await pool.connect();
    await storeOtp(client, identifier, otp);
    console.log('[Auth] Resend OTP for', identifier, ':', otp, '(demo)');
    res.json({ sent: true });
  } catch (err) {
    console.error('ResendOtp:', err);
    res.status(500).json({ error: 'Failed to resend OTP' });
  } finally {
    if (client) client.release();
  }
}

// ─── Refresh / keep-alive ──────────────────────────────────────────────────────
async function handleRefresh(req, res) {
  var b  = req.body || {};
  var rt = b.refreshToken || '';

  // Simple keep-alive: re-issue access token from Bearer header
  if (!rt) {
    var header = req.headers['authorization'] || '';
    var token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.json({ ok: true });
    try {
      var payload  = authLib.verifyAccessToken(token);
      var newToken = authLib.signAccessToken({ id: payload.id, email: payload.email, name: payload.name });
      return res.json({ accessToken: newToken });
    } catch (e) {
      return res.json({ ok: true });
    }
  }

  // Full refresh token rotation
  var client;
  try {
    client = await pool.connect();
    var rh = await authLib.hashToken(rt);
    var r  = await client.query(
      'SELECT * FROM refresh_tokens WHERE token_hash=$1 AND revoked=FALSE AND expires_at>NOW()',
      [rh]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid or expired refresh token' });

    var userId = r.rows[0].user_id;
    var uRes   = await client.query(
      'SELECT id,name,email,phone,is_active,email_verified,flyyb_id,default_currency FROM users WHERE id=$1',
      [userId]
    );
    var u = uRes.rows[0];
    if (!u) return res.status(401).json({ error: 'User not found' });

    var newRt  = authLib.generateRefreshToken();
    var newRh  = await authLib.hashToken(newRt);
    var exp    = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await client.query('UPDATE refresh_tokens SET revoked=TRUE WHERE token_hash=$1', [rh]);
    await client.query('INSERT INTO refresh_tokens (user_id,token_hash,expires_at) VALUES ($1,$2,$3)', [userId, newRh, exp]);

    res.json({ accessToken: authLib.signAccessToken(u), refreshToken: newRt, expiresIn: 3600 });
  } catch (err) {
    console.error('Refresh:', err);
    res.status(500).json({ error: 'Token refresh failed' });
  } finally {
    if (client) client.release();
  }
}

// ─── Logout ────────────────────────────────────────────────────────────────────
async function handleLogout(req, res) {
  var b  = req.body || {};
  var rt = b.refreshToken || '';
  if (rt) {
    var client;
    try {
      client = await pool.connect();
      var rh = await authLib.hashToken(rt);
      await client.query('UPDATE refresh_tokens SET revoked=TRUE WHERE token_hash=$1', [rh]);
    } catch (e) {
      console.error('Logout:', e);
    } finally {
      if (client) client.release();
    }
  }
  res.json({ ok: true });
}

// ─── Config (Stripe publishable key) ──────────────────────────────────────────
function handleConfig(req, res) {
  var key = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!key) return res.status(500).json({ error: 'Stripe not configured' });
  res.json({ stripeKey: key });
}
