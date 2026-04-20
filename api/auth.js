/**
 * FLYYB API — api/auth.js  (BAU restored + new actions added)
 *
 * Restored from BAU:
 *   - Brevo email sending (BREVO_SMTP_KEY, BREVO_FROM_EMAIL env vars)
 *   - otp_verifications table (not otp_codes)
 *   - OTP bcrypt-hashed with cost 8
 *   - SMS OTP → sends email to ADMIN_PERSONAL_EMAIL
 *   - genId() for flyyb_id, isStrong() password check
 *   - authLib.cors() for CORS handling
 *
 * New additions from this chat:
 *   - action=refresh (keep-alive ping)
 *   - action=config  (Stripe key)
 */

var pg      = require('pg');
var authLib = require('../lib/auth');
var pool    = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── Helpers (BAU, unchanged) ─────────────────────────────────────────────────

function isStrong(pw) {
  if (pw.length < 8) return false;
  var h=false, u=false, d=false;
  for (var i=0; i<pw.length; i++) {
    var c=pw[i];
    if (c>='a'&&c<='z') h=true;
    if (c>='A'&&c<='Z') u=true;
    if (c>='0'&&c<='9') d=true;
  }
  return h && u && d;
}

function genId() {
  var c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789', id='FLY';
  for (var i=0; i<7; i++) id += c[Math.floor(Math.random()*c.length)];
  return id;
}

function genOTP()         { return String(Math.floor(100000 + Math.random()*900000)); }
function hashOTP(o)       { return require('bcryptjs').hash(o, 8); }
function verifyOTP(o, h)  { return require('bcryptjs').compare(o, h); }

// ─── Email via Brevo (BAU, unchanged) ─────────────────────────────────────────

async function sendEmail(to, subject, html) {
  var k = process.env.BREVO_SMTP_KEY;
  var f = process.env.BREVO_FROM_EMAIL;
  if (!k || !f) { console.log('=== EMAIL to ' + to + ' | ' + subject + ' ==='); return true; }
  try {
    var r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': k },
      body: JSON.stringify({ sender: { name: 'FLYYB', email: f }, to: [{ email: to }], subject, htmlContent: html })
    });
    if (!r.ok) { var e = await r.text(); console.error('Brevo:', e); }
    return r.ok;
  } catch (e) { console.error('Email:', e.message); return false; }
}

function otpHtml(otp, name, title, extra) {
  return '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0a0a0f;color:#f5f0e8;padding:32px;border-radius:8px">'
    + '<h1 style="font-size:24px;letter-spacing:4px;margin-bottom:8px">FLY<span style="color:#d4a843">YB</span></h1>'
    + '<p style="color:rgba(245,240,232,.6);font-size:13px;margin-bottom:24px">fly with vibe</p>'
    + '<h2 style="font-size:18px;margin-bottom:16px">' + title + '</h2>'
    + (extra ? '<p style="color:rgba(245,240,232,.5);font-size:13px;margin-bottom:12px">' + extra + '</p>' : '')
    + '<p style="font-size:14px;margin-bottom:24px">Hi ' + (name||'there') + ', your OTP is:</p>'
    + '<div style="background:rgba(212,168,67,.15);border:1px solid rgba(212,168,67,.3);border-radius:4px;padding:20px;text-align:center;margin-bottom:24px">'
    + '<span style="font-family:monospace;font-size:32px;letter-spacing:8px;color:#d4a843">' + otp + '</span></div>'
    + '<p style="color:rgba(245,240,232,.4);font-size:12px">Expires in 10 minutes. Do not share.</p></div>';
}

async function sendOTPEmail(email, otp, name, purpose) {
  return sendEmail(email,
    purpose === 'verify' ? 'Verify your FLYYB account' : 'Your FLYYB OTP',
    otpHtml(otp, name, purpose === 'verify' ? 'Verify your email' : 'Your OTP', null)
  );
}

async function smsOtpGenerationForMobileNo(phone, otp, name) {
  var admin = process.env.ADMIN_PERSONAL_EMAIL;
  if (!admin) { console.log('=== MOBILE OTP for ' + phone + ': ' + otp + ' ==='); return true; }
  return sendEmail(admin, '[FLYYB ADMIN] Mobile OTP - ' + phone,
    otpHtml(otp, 'Admin', 'Mobile OTP Request',
      'Customer mobile: <b>' + phone + '</b><br>Name: <b>' + (name||'Unknown') + '</b><br><br>Share this OTP with the customer via SMS.')
  );
}

// ─── Booking / trip confirmation emails ───────────────────────────────────────

function bookingHtml(ref, name, origin, dest, depDate, depTime, arrTime, cabin, pax, total, sym) {
  return '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0a0a0f;color:#f5f0e8;padding:32px;border-radius:8px">'
    + '<h1 style="font-size:24px;letter-spacing:4px;margin-bottom:4px">FLY<span style="color:#d4a843">YB</span></h1>'
    + '<p style="color:rgba(245,240,232,.6);font-size:13px;margin-bottom:24px">fly with vibe</p>'
    + '<h2 style="font-size:18px;margin-bottom:16px">✈ Booking Confirmed</h2>'
    + '<p style="font-size:14px;margin-bottom:20px">Hi ' + (name||'there') + ', your flight is booked!</p>'
    + '<div style="background:rgba(212,168,67,.08);border:1px solid rgba(212,168,67,.25);border-radius:6px;padding:20px;margin-bottom:20px">'
    + '<div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="color:rgba(245,240,232,.5);font-size:12px">BOOKING REF</span><span style="font-family:monospace;color:#d4a843;font-size:14px;letter-spacing:2px">' + ref + '</span></div>'
    + '<div style="font-size:20px;font-weight:600;margin:12px 0">' + origin + ' → ' + dest + '</div>'
    + '<div style="color:rgba(245,240,232,.7);font-size:13px;margin-bottom:4px">📅 ' + depDate + ' &nbsp;|&nbsp; 🕐 ' + depTime + ' – ' + arrTime + '</div>'
    + '<div style="color:rgba(245,240,232,.7);font-size:13px">💺 ' + (cabin||'Economy') + ' &nbsp;|&nbsp; 👤 ' + (pax||1) + ' passenger' + ((pax||1)>1?'s':'') + '</div>'
    + '</div>'
    + '<div style="display:flex;justify-content:space-between;border-top:1px solid rgba(255,255,255,.08);padding-top:16px">'
    + '<span style="color:rgba(245,240,232,.5)">Total Paid</span>'
    + '<span style="color:#d4a843;font-size:18px;font-weight:600">' + (sym||'$') + parseFloat(total||0).toFixed(2) + '</span></div>'
    + '<p style="color:rgba(245,240,232,.4);font-size:11px;margin-top:24px">Keep this email as your booking confirmation. Check in opens 24 hours before departure.</p></div>';
}

async function sendBookingEmail(email, name, booking) {
  if (!email) return;
  var html = bookingHtml(
    booking.ref, name, booking.origin, booking.dest, booking.depDate,
    booking.depTime, booking.arrTime, booking.cabin, booking.pax, booking.total, booking.sym
  );
  await sendEmail(email, 'Your FLYYB booking is confirmed — ' + booking.ref, html);
}

async function sendCancellationEmail(email, name, ref, origin, dest) {
  if (!email) return;
  var html = '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0a0a0f;color:#f5f0e8;padding:32px;border-radius:8px">'
    + '<h1 style="font-size:24px;letter-spacing:4px;margin-bottom:8px">FLY<span style="color:#d4a843">YB</span></h1>'
    + '<h2 style="font-size:18px;margin-bottom:16px">Booking Cancelled</h2>'
    + '<p style="font-size:14px;margin-bottom:20px">Hi ' + (name||'there') + ', your booking <b style="color:#d4a843">' + ref + '</b> (' + origin + ' → ' + dest + ') has been cancelled.</p>'
    + '<p style="color:rgba(245,240,232,.5);font-size:13px">A refund will be processed to your original payment method within 5–10 business days.</p></div>';
  await sendEmail(email, 'FLYYB booking cancelled — ' + ref, html);
}

async function sendRescheduleEmail(email, name, ref, origin, dest, newDate) {
  if (!email) return;
  var html = '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0a0a0f;color:#f5f0e8;padding:32px;border-radius:8px">'
    + '<h1 style="font-size:24px;letter-spacing:4px;margin-bottom:8px">FLY<span style="color:#d4a843">YB</span></h1>'
    + '<h2 style="font-size:18px;margin-bottom:16px">Booking Rescheduled</h2>'
    + '<p style="font-size:14px;margin-bottom:20px">Hi ' + (name||'there') + ', your booking <b style="color:#d4a843">' + ref + '</b> (' + origin + ' → ' + dest + ') has been rescheduled to <b>' + newDate + '</b>.</p>'
    + '<p style="color:rgba(245,240,232,.5);font-size:13px">Please check in online 24 hours before your new departure date.</p></div>';
  await sendEmail(email, 'FLYYB booking rescheduled — ' + ref, html);
}

// ─── Register (BAU, unchanged) ────────────────────────────────────────────────

async function handleRegister(req, res) {
  var b=req.body||{}, name=b.name, email=b.email, password=b.password, currency=b.currency||'USD', provider=b.provider||'email', phone=b.phone, dial=b.dial;
  if (!name||name.trim().length<2) return res.status(400).json({ error: 'Name must be at least 2 characters' });
  if (!currency||currency.length!==3) return res.status(400).json({ error: 'Default currency is required' });
  var client;
  try {
    client = await pool.connect();
    var cc = await client.query('SELECT code FROM currencies WHERE code=$1', [currency]);
    if (!cc.rows.length) return res.status(400).json({ error: 'Invalid currency' });
    if (provider === 'phone') {
      if (!phone) return res.status(400).json({ error: 'Mobile number required' });
      var fp = (dial||'') + phone;
      var otp=genOTP(), oh=await hashOTP(otp), exp=new Date(Date.now()+10*60*1000);
      var purpose = 'mobile-reg:' + name.trim() + ':' + currency;
      await client.query('INSERT INTO otp_verifications (email,otp_hash,purpose,expires_at) VALUES ($1,$2,$3,$4)', [fp, oh, purpose, exp]);
      await smsOtpGenerationForMobileNo(fp, otp, name);
      return res.status(201).json({ message: 'OTP sent for verification.', phone: fp, requiresVerification: true });
    }
    if (!email||email.indexOf('@')<0) return res.status(400).json({ error: 'Valid email required' });
    if (!password||password.length<8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!isStrong(password)) return res.status(400).json({ error: 'Password needs uppercase, lowercase and a number' });
    var ex = await client.query('SELECT id FROM users WHERE lower(email)=lower($1)', [email]);
    if (ex.rows.length) return res.status(409).json({ error: 'An account with this email already exists' });
    var hash = await authLib.hashPassword(password);
    var fid = genId();
    var ic = await client.query('SELECT id FROM users WHERE flyyb_id=$1', [fid]);
    while (ic.rows.length) { fid=genId(); ic=await client.query('SELECT id FROM users WHERE flyyb_id=$1', [fid]); }
    var ur = await client.query(
      'INSERT INTO users (name,email,password_hash,auth_provider,is_verified,email_verified,flyyb_id,default_currency) VALUES ($1,$2,$3,$4,FALSE,FALSE,$5,$6) RETURNING id,name,email,flyyb_id',
      [name.trim(), email.toLowerCase(), hash, 'email', fid, currency]
    );
    var user = ur.rows[0];
    await client.query('INSERT INTO credits (user_id,balance) VALUES ($1,0)', [user.id]);
    var otp2=genOTP(), oh2=await hashOTP(otp2), exp2=new Date(Date.now()+10*60*1000);
    await client.query('INSERT INTO otp_verifications (email,otp_hash,purpose,expires_at) VALUES ($1,$2,$3,$4)', [email.toLowerCase(), oh2, 'verify', exp2]);
    await sendOTPEmail(email, otp2, name, 'verify');
    res.status(201).json({ message: 'Registration successful. Check your email for OTP.', userId: user.id, flyybId: user.flyyb_id, requiresVerification: true });
  } catch (err) { console.error('Register:', err); res.status(500).json({ error: 'Registration failed' }); }
  finally { if (client) client.release(); }
}

// ─── Verify OTP (BAU, unchanged) ──────────────────────────────────────────────

async function handleVerifyOTP(req, res) {
  var b=req.body||{}, identifier=(b.email||b.phone||'').toLowerCase().trim(), otp=b.otp;
  if (!identifier||!otp) return res.status(400).json({ error: 'Identifier and OTP required' });
  var client;
  try {
    client = await pool.connect();
    var rows = await client.query('SELECT id,otp_hash,expires_at,purpose FROM otp_verifications WHERE email=lower($1) AND used=FALSE ORDER BY created_at DESC LIMIT 1', [identifier]);
    if (!rows.rows.length) return res.status(400).json({ error: 'No pending verification found' });
    var rec = rows.rows[0];
    if (new Date(rec.expires_at) < new Date()) return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
    var valid = await verifyOTP(otp, rec.otp_hash);
    if (!valid) return res.status(400).json({ error: 'Invalid OTP' });
    await client.query('UPDATE otp_verifications SET used=TRUE WHERE id=$1', [rec.id]);
    var user;
    if (rec.purpose && rec.purpose.startsWith('mobile-reg:')) {
      var parts=rec.purpose.split(':'), mname=parts[1]||'User', mcurr=parts[2]||'USD';
      var fid=genId(), ic=await client.query('SELECT id FROM users WHERE flyyb_id=$1', [fid]);
      while (ic.rows.length) { fid=genId(); ic=await client.query('SELECT id FROM users WHERE flyyb_id=$1', [fid]); }
      var ur=await client.query('INSERT INTO users (name,phone,auth_provider,is_verified,email_verified,flyyb_id,default_currency) VALUES ($1,$2,$3,TRUE,TRUE,$4,$5) RETURNING id,name,phone,flyyb_id,default_currency', [mname, identifier, 'phone', fid, mcurr]);
      user=ur.rows[0];
      await client.query('INSERT INTO credits (user_id,balance) VALUES ($1,0)', [user.id]);
    } else {
      var ur2=await client.query('UPDATE users SET email_verified=TRUE,is_verified=TRUE WHERE lower(email)=lower($1) RETURNING id,name,email,flyyb_id,default_currency', [identifier]);
      user=ur2.rows[0];
      if (!user) return res.status(404).json({ error: 'User not found' });
    }
    var at=authLib.signAccessToken(user), rt=authLib.generateRefreshToken(), rh=await authLib.hashToken(rt), exp=new Date(Date.now()+30*24*60*60*1000);
    await client.query('INSERT INTO refresh_tokens (user_id,token_hash,expires_at) VALUES ($1,$2,$3)', [user.id, rh, exp]);
    res.json({ user: { id:user.id, name:user.name, email:user.email||null, phone:user.phone||null, flyybId:user.flyyb_id, currency:user.default_currency }, accessToken:at, refreshToken:rt, expiresIn:3600, credits:0 });
  } catch (err) { console.error('VerifyOTP:', err); res.status(500).json({ error: 'Verification failed' }); }
  finally { if (client) client.release(); }
}

// ─── Send login OTP / Login OTP / Resend OTP (BAU, unchanged) ────────────────

async function handleSendLoginOTP(req, res) {
  var b=req.body||{}, phone=b.phone;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  var client;
  try {
    client = await pool.connect();
    var ur = await client.query('SELECT id,name FROM users WHERE phone=$1', [phone]);
    if (!ur.rows.length) return res.status(404).json({ error: 'No account found for this number. Please register first.' });
    var otp=genOTP(), oh=await hashOTP(otp), exp=new Date(Date.now()+10*60*1000);
    await client.query('INSERT INTO otp_verifications (email,otp_hash,purpose,expires_at) VALUES ($1,$2,$3,$4)', [phone, oh, 'login', exp]);
    await smsOtpGenerationForMobileNo(phone, otp, ur.rows[0].name);
    res.json({ message: 'OTP sent' });
  } catch (err) { console.error('SendLoginOTP:', err); res.status(500).json({ error: 'Failed to send OTP' }); }
  finally { if (client) client.release(); }
}

async function handleLoginOTP(req, res) {
  var b=req.body||{}, phone=b.phone, otp=b.otp;
  if (!phone||!otp) return res.status(400).json({ error: 'Phone and OTP required' });
  var client;
  try {
    client = await pool.connect();
    var rows = await client.query('SELECT id,otp_hash,expires_at FROM otp_verifications WHERE email=$1 AND purpose=$2 AND used=FALSE ORDER BY created_at DESC LIMIT 1', [phone, 'login']);
    if (!rows.rows.length) return res.status(400).json({ error: 'No pending OTP found. Please request a new one.' });
    var rec=rows.rows[0];
    if (new Date(rec.expires_at) < new Date()) return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
    var valid = await verifyOTP(otp, rec.otp_hash);
    if (!valid) return res.status(400).json({ error: 'Invalid OTP' });
    await client.query('UPDATE otp_verifications SET used=TRUE WHERE id=$1', [rec.id]);
    var ur = await client.query('SELECT id,name,email,phone,flyyb_id,default_currency FROM users WHERE phone=$1', [phone]);
    var user = ur.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    var at=authLib.signAccessToken(user), rt=authLib.generateRefreshToken(), rh=await authLib.hashToken(rt), exp=new Date(Date.now()+30*24*60*60*1000);
    await client.query('INSERT INTO refresh_tokens (user_id,token_hash,expires_at) VALUES ($1,$2,$3)', [user.id, rh, exp]);
    var cr = await client.query('SELECT balance FROM credits WHERE user_id=$1', [user.id]);
    res.json({ user: { id:user.id, name:user.name, email:user.email||null, phone:user.phone, flyybId:user.flyyb_id, currency:user.default_currency }, accessToken:at, refreshToken:rt, expiresIn:3600, credits:parseFloat((cr.rows[0]&&cr.rows[0].balance)||0) });
  } catch (err) { console.error('LoginOTP:', err); res.status(500).json({ error: 'Login failed' }); }
  finally { if (client) client.release(); }
}

async function handleResendOTP(req, res) {
  var b=req.body||{}, email=b.email, purpose=b.purpose||'verify';
  if (!email) return res.status(400).json({ error: 'Email required' });
  var client;
  try {
    client = await pool.connect();
    var ur = await client.query('SELECT id,name,email_verified FROM users WHERE lower(email)=lower($1)', [email]);
    var user = ur.rows[0];
    if (!user) return res.status(404).json({ error: 'No account found' });
    if (purpose==='verify' && user.email_verified) return res.status(400).json({ error: 'Email already verified' });
    var cnt = await client.query("SELECT COUNT(*) FROM otp_verifications WHERE email=lower($1) AND created_at>NOW()-INTERVAL '1 hour'", [email]);
    if (parseInt(cnt.rows[0].count) >= 3) return res.status(429).json({ error: 'Too many OTP requests. Please wait.' });
    var otp=genOTP(), oh=await hashOTP(otp), exp=new Date(Date.now()+10*60*1000);
    await client.query('INSERT INTO otp_verifications (email,otp_hash,purpose,expires_at) VALUES ($1,$2,$3,$4)', [email.toLowerCase(), oh, purpose, exp]);
    await sendOTPEmail(email, otp, user.name, purpose);
    res.json({ message: 'OTP sent to ' + email });
  } catch (err) { console.error('ResendOTP:', err); res.status(500).json({ error: 'Failed to send OTP' }); }
  finally { if (client) client.release(); }
}

// ─── Login (BAU, unchanged) ───────────────────────────────────────────────────

async function handleLogin(req, res) {
  var b=req.body||{};
  if (!b.password) return res.status(400).json({ error: 'Password required' });
  if (!b.email&&!b.phone) return res.status(400).json({ error: 'Email or phone required' });
  var client, u;
  try {
    client = await pool.connect();
    var qr;
    if (b.email) qr=await client.query('SELECT id,name,email,phone,password_hash,is_active,email_verified,flyyb_id,default_currency FROM users WHERE lower(email)=lower($1)', [b.email]);
    else         qr=await client.query('SELECT id,name,email,phone,password_hash,is_active,email_verified,flyyb_id,default_currency FROM users WHERE phone=$1', [b.phone]);
    u = qr.rows[0];
    if (!u||!u.password_hash) return res.status(401).json({ error: 'Invalid credentials' });
    if (!u.is_active) return res.status(403).json({ error: 'Account is disabled' });
    var valid = await authLib.verifyPassword(b.password, u.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    var at=authLib.signAccessToken(u), rt=authLib.generateRefreshToken(), rh=await authLib.hashToken(rt), exp=new Date(Date.now()+30*24*60*60*1000);
    await client.query('UPDATE refresh_tokens SET revoked=TRUE WHERE user_id=$1', [u.id]);
    await client.query('INSERT INTO refresh_tokens (user_id,token_hash,expires_at) VALUES ($1,$2,$3)', [u.id, rh, exp]);
    var cr = await client.query('SELECT balance FROM credits WHERE user_id=$1', [u.id]);
    var credits = parseFloat((cr.rows[0]&&cr.rows[0].balance)||0);
    res.json({ user: { id:u.id, name:u.name, email:u.email, phone:u.phone, flyybId:u.flyyb_id, currency:u.default_currency, emailVerified:u.email_verified }, accessToken:at, refreshToken:rt, expiresIn:3600, credits });
  } catch (err) { console.error('Login:', err); res.status(500).json({ error: 'Login failed' }); }
  finally { if (client) client.release(); }
}

// ─── Me / Logout (BAU, unchanged) ────────────────────────────────────────────

async function handleMe(req, res) {
  var p=authLib.requireAuth(req,res); if (!p) return;
  var client;
  try {
    client = await pool.connect();
    var r = await client.query('SELECT u.id,u.name,u.email,u.phone,u.auth_provider,u.is_verified,u.email_verified,u.flyyb_id,u.default_currency,u.created_at,c.balance AS credits FROM users u LEFT JOIN credits c ON c.user_id=u.id WHERE u.id=$1 AND u.is_active=TRUE', [p.sub||p.id]);
    var u=r.rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    res.json({ user: { id:u.id, name:u.name, email:u.email, phone:u.phone, provider:u.auth_provider, verified:u.is_verified, emailVerified:u.email_verified, flyybId:u.flyyb_id, currency:u.default_currency, joined:u.created_at }, credits:parseFloat(u.credits||0) });
  } catch (err) { console.error('Me:', err); res.status(500).json({ error: 'Failed' }); }
  finally { if (client) client.release(); }
}

async function handleLogout(req, res) {
  var p=authLib.requireAuth(req,res); if (!p) return;
  var client;
  try {
    client = await pool.connect();
    await client.query('UPDATE refresh_tokens SET revoked=TRUE WHERE user_id=$1', [p.sub||p.id]);
    res.json({ message: 'Logged out' });
  } catch (err) { res.status(500).json({ error: 'Logout failed' }); }
  finally { if (client) client.release(); }
}

// ─── Refresh (NEW — keep-alive ping every 6 min) ──────────────────────────────

async function handleRefresh(req, res) {
  var b=req.body||{}, rt=b.refreshToken||'';
  if (!rt) {
    // Simple keep-alive: re-issue from Bearer header
    var header=req.headers['authorization']||'', token=header.startsWith('Bearer ')?header.slice(7):null;
    if (!token) return res.json({ ok: true });
    try {
      var payload=authLib.verifyAccessToken(token);
      return res.json({ accessToken: authLib.signAccessToken({ id:payload.id||payload.sub, email:payload.email, name:payload.name }) });
    } catch (e) { return res.json({ ok: true }); }
  }
  // Full rotation
  var client;
  try {
    client = await pool.connect();
    var rh=await authLib.hashToken(rt), r=await client.query('SELECT * FROM refresh_tokens WHERE token_hash=$1 AND revoked=FALSE AND expires_at>NOW()', [rh]);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid or expired refresh token' });
    var userId=r.rows[0].user_id, uRes=await client.query('SELECT id,name,email,flyyb_id,default_currency FROM users WHERE id=$1', [userId]);
    var u=uRes.rows[0]; if (!u) return res.status(401).json({ error: 'User not found' });
    var newRt=authLib.generateRefreshToken(), newRh=await authLib.hashToken(newRt), exp=new Date(Date.now()+30*24*60*60*1000);
    await client.query('UPDATE refresh_tokens SET revoked=TRUE WHERE token_hash=$1', [rh]);
    await client.query('INSERT INTO refresh_tokens (user_id,token_hash,expires_at) VALUES ($1,$2,$3)', [userId, newRh, exp]);
    res.json({ accessToken:authLib.signAccessToken(u), refreshToken:newRt, expiresIn:3600 });
  } catch (err) { console.error('Refresh:', err); res.status(500).json({ error: 'Token refresh failed' }); }
  finally { if (client) client.release(); }
}

// ─── Module export (BAU structure + new actions) ─────────────────────────────

module.exports = function(req, res) {
  if (authLib.cors(req, res)) return;
  var a = req.query.action;
  if (a === 'register')       return handleRegister(req, res);
  if (a === 'verify-otp')     return handleVerifyOTP(req, res);
  if (a === 'resend-otp')     return handleResendOTP(req, res);
  if (a === 'send-login-otp') return handleSendLoginOTP(req, res);
  if (a === 'login-otp')      return handleLoginOTP(req, res);
  if (a === 'login')          return handleLogin(req, res);
  if (a === 'me')             return handleMe(req, res);
  if (a === 'logout')         return handleLogout(req, res);
  if (a === 'refresh')        return handleRefresh(req, res);
  if (a === 'config')         return res.json({ stripeKey: process.env.STRIPE_PK||process.env.STRIPE_PUBLISHABLE_KEY||'' });
  return res.status(400).json({ error: 'Missing action' });
};

// Export email helpers so booking.js and trips.js can use them
module.exports.sendBookingEmail    = sendBookingEmail;
module.exports.sendCancellationEmail = sendCancellationEmail;
module.exports.sendRescheduleEmail = sendRescheduleEmail;
