/**
 * FLYYB API — api/auth.js
 * POST /api/auth?action=...
 *
 * Actions: login | register | send-login-otp | login-otp |
 *          verify-otp | resend-otp | refresh | logout
 *
 * Env vars: DATABASE_URL, JWT_SECRET
 */
const bcrypt         = require('bcryptjs');
const { query }      = require('../lib/db');
const { signToken, verifyToken } = require('../lib/auth');
const { handleCors } = require('../lib/cors');
const { ok, badRequest, unauthorised, serverError, wrap } = require('../lib/respond');

module.exports = wrap(async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed.' });

  const action = req.query && req.query.action || req.body && req.body.action;

  if (action === 'login')          return handleLogin(req, res);
  if (action === 'register')       return handleRegister(req, res);
  if (action === 'send-login-otp') return handleSendOtp(req, res);
  if (action === 'login-otp')      return handleVerifyLoginOtp(req, res);
  if (action === 'verify-otp')     return handleVerifyOtp(req, res);
  if (action === 'resend-otp')     return handleResendOtp(req, res);
  if (action === 'refresh')        return handleRefresh(req, res);
  if (action === 'logout')         return ok(res, { ok: true });

  return badRequest(res, 'Unknown action: "' + action + '"');
});

// ── Login ─────────────────────────────────────────────────────────────────────
async function handleLogin(req, res) {
  const body     = req.body || {};
  const email    = body.email || '';
  const password = body.password || '';

  if (!email || !password) return badRequest(res, 'Email and password are required.');

  let rows;
  try {
    const result = await query(
      'SELECT id,email,name,password_hash,currency,credits FROM users WHERE lower(email)=lower($1) LIMIT 1',
      [email]
    );
    rows = result.rows;
  } catch (err) { return serverError(res, err); }

  const user = rows[0];
  if (!user) return unauthorised(res, 'Invalid email or password.');

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match)  return unauthorised(res, 'Invalid email or password.');

  const token = signToken({ id: user.id, email: user.email });
  console.log('[Auth] Login:', user.email);

  return ok(res, {
    accessToken: token,
    user: {
      id:       user.id,
      name:     user.name,
      email:    user.email,
      currency: user.currency || 'USD',
      flyybId:  'FLY' + String(user.id).padStart(6, '0'),
    },
    credits: parseFloat(user.credits) || 0,
  });
}

// ── Register ──────────────────────────────────────────────────────────────────
async function handleRegister(req, res) {
  const body     = req.body || {};
  const name     = body.name || '';
  const email    = (body.email || '').toLowerCase();
  const phone    = body.phone || '';
  const dial     = body.dial || '';
  const currency = body.currency || 'USD';
  const provider = body.provider || 'email';
  const password = body.password || '';

  if (provider === 'email') {
    if (!name || !email || !password) return badRequest(res, 'Name, email and password are required.');
    if (password.length < 8 && !body._enc) return badRequest(res, 'Password must be at least 8 characters.');
  } else {
    if (!name || !phone) return badRequest(res, 'Name and phone are required.');
  }

  const identifier = email || (dial + phone);

  let existing;
  try {
    const result = await query(
      'SELECT id FROM users WHERE lower(email)=$1 OR phone=$2',
      [email, phone ? (dial + phone) : '']
    );
    existing = result.rows;
  } catch (err) { return serverError(res, err); }

  if (existing.length) return badRequest(res, 'An account with this email/phone already exists.');

  let newUser;
  try {
    if (provider === 'email') {
      const hash        = await bcrypt.hash(password, 12);
      const result      = await query(
        'INSERT INTO users (name,email,password_hash,currency,credits,email_verified) VALUES ($1,$2,$3,$4,0,false) RETURNING id,name,email,currency',
        [name, email, hash, currency]
      );
      newUser = result.rows[0];
    } else {
      const result = await query(
        'INSERT INTO users (name,phone,currency,credits) VALUES ($1,$2,$3,0) RETURNING id,name,phone,currency',
        [name, dial + phone, currency]
      );
      newUser = result.rows[0];
    }
  } catch (err) { return serverError(res, err); }

  // Store OTP
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  try {
    await query(
      "INSERT INTO otp_codes (identifier,code,expires_at) VALUES ($1,$2,NOW()+INTERVAL '10 minutes') ON CONFLICT (identifier) DO UPDATE SET code=$2,expires_at=NOW()+INTERVAL '10 minutes'",
      [identifier, otp]
    );
  } catch (e) { console.warn('[Auth] OTP insert warning:', e.message); }

  console.log('[Auth] Register:', identifier, '| OTP (demo):', otp);
  return ok(res, { registered: true, requiresOtp: true });
}

// ── Verify OTP (email registration) ──────────────────────────────────────────
async function handleVerifyOtp(req, res) {
  const body       = req.body || {};
  const email      = (body.email || '').toLowerCase();
  const identifier = email || body.phone || '';
  const otp        = body.otp || '';

  if (!identifier || !otp) return badRequest(res, 'Email/phone and OTP are required.');

  let rows;
  try {
    const result = await query(
      'SELECT * FROM otp_codes WHERE identifier=$1 AND code=$2 AND expires_at>NOW()',
      [identifier, otp]
    );
    rows = result.rows;
  } catch (err) { return serverError(res, err); }

  if (!rows.length) return unauthorised(res, 'Invalid or expired OTP.');

  await query('DELETE FROM otp_codes WHERE identifier=$1', [identifier]).catch(function() {});

  let user;
  try {
    if (email) {
      await query('UPDATE users SET email_verified=true WHERE lower(email)=$1', [email]);
      const result = await query(
        'SELECT id,name,email,currency,credits FROM users WHERE lower(email)=$1',
        [email]
      );
      user = result.rows[0];
    }
  } catch (err) { return serverError(res, err); }

  if (!user) return serverError(res, new Error('User not found after OTP verify'));

  const token = signToken({ id: user.id, email: user.email });
  console.log('[Auth] OTP verified:', identifier);

  return ok(res, {
    accessToken: token,
    user: {
      id:       user.id,
      name:     user.name,
      email:    user.email,
      currency: user.currency || 'USD',
      flyybId:  'FLY' + String(user.id).padStart(6, '0'),
    },
    credits: parseFloat(user.credits) || 0,
  });
}

// ── Send OTP (phone login) ────────────────────────────────────────────────────
async function handleSendOtp(req, res) {
  const body  = req.body || {};
  const phone = body.phone || '';
  if (!phone) return badRequest(res, 'Phone number is required.');

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  try {
    await query(
      "INSERT INTO otp_codes (identifier,code,expires_at) VALUES ($1,$2,NOW()+INTERVAL '10 minutes') ON CONFLICT (identifier) DO UPDATE SET code=$2,expires_at=NOW()+INTERVAL '10 minutes'",
      [phone, otp]
    );
  } catch (err) { return serverError(res, err); }

  console.log('[Auth] Phone OTP for', phone, ':', otp, '(demo — send via SMS in production)');
  return ok(res, { sent: true });
}

// ── Verify OTP (phone login) ──────────────────────────────────────────────────
async function handleVerifyLoginOtp(req, res) {
  const body  = req.body || {};
  const phone = body.phone || '';
  const otp   = body.otp || '';
  if (!phone || !otp) return badRequest(res, 'Phone and OTP are required.');

  let rows;
  try {
    const result = await query(
      'SELECT * FROM otp_codes WHERE identifier=$1 AND code=$2 AND expires_at>NOW()',
      [phone, otp]
    );
    rows = result.rows;
  } catch (err) { return serverError(res, err); }

  if (!rows.length) return unauthorised(res, 'Invalid or expired OTP.');
  await query('DELETE FROM otp_codes WHERE identifier=$1', [phone]).catch(function() {});

  let user;
  try {
    const existing = await query('SELECT * FROM users WHERE phone=$1', [phone]);
    if (existing.rows.length) {
      user = existing.rows[0];
    } else {
      const created = await query('INSERT INTO users (phone,credits) VALUES ($1,0) RETURNING *', [phone]);
      user = created.rows[0];
    }
  } catch (err) { return serverError(res, err); }

  const token = signToken({ id: user.id, email: user.email || phone });
  return ok(res, {
    accessToken: token,
    user: {
      id:       user.id,
      name:     user.name || phone,
      email:    user.email,
      currency: user.currency || 'USD',
      flyybId:  'FLY' + String(user.id).padStart(6, '0'),
    },
    credits: parseFloat(user.credits) || 0,
  });
}

// ── Resend OTP ────────────────────────────────────────────────────────────────
async function handleResendOtp(req, res) {
  const body       = req.body || {};
  const identifier = body.email ? (body.email || '').toLowerCase() : (body.phone || '');
  if (!identifier) return badRequest(res, 'Email or phone required.');

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  try {
    await query(
      "INSERT INTO otp_codes (identifier,code,expires_at) VALUES ($1,$2,NOW()+INTERVAL '10 minutes') ON CONFLICT (identifier) DO UPDATE SET code=$2,expires_at=NOW()+INTERVAL '10 minutes'",
      [identifier, otp]
    );
  } catch (err) { return serverError(res, err); }

  console.log('[Auth] Resend OTP for', identifier, ':', otp, '(demo)');
  return ok(res, { sent: true });
}

// ── Refresh (keep-alive ping from frontend every 6 min while user is active) ──
async function handleRefresh(req, res) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return ok(res, { ok: true });

  try {
    const payload  = verifyToken(token);
    const newToken = signToken({ id: payload.id, email: payload.email });
    return ok(res, { accessToken: newToken });
  } catch (e) {
    // Token expired — return 200 silently (frontend handles expiry separately)
    return ok(res, { ok: true });
  }
}
