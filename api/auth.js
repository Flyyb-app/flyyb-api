/**

- FLYYB API — api/auth.js
- 
- POST /api/auth
- Body: { action, …fields }
- 
- Actions:
- login     → { email, password }
- register  → { firstName, lastName, email, password }
- sendOtp   → { phone }
- verifyOtp → { phone, code }
- 
- Returns: { token, user }
  */

const bcrypt      = require('bcryptjs');
const { query }   = require('../lib/db');
const { signToken }  = require('../lib/auth');
const { handleCors } = require('../lib/cors');
const { ok, badRequest, unauthorised, serverError, wrap } = require('../lib/respond');

module.exports = wrap(async (req, res) => {
if (handleCors(req, res)) return;

if (req.method !== 'POST') {
return res.status(405).json({ message: 'Method not allowed.' });
}

const { action } = req.body ?? {};

if (action === 'login')     return handleLogin(req, res);
if (action === 'register')  return handleRegister(req, res);
if (action === 'sendOtp')   return handleSendOtp(req, res);
if (action === 'verifyOtp') return handleVerifyOtp(req, res);

return badRequest(res, 'Unknown action: "${action}"');
});

// ── Login ─────────────────────────────────────────────────────────────────────
async function handleLogin(req, res) {
const { email, password } = req.body;

if (!email || !password) return badRequest(res, 'Email and password are required.');

let rows;
try {
({ rows } = await query('SELECT * FROM users WHERE email = $1 LIMIT 1', [email.toLowerCase()]));
} catch (err) {
return serverError(res, err);
}

const user = rows[0];
if (!user) return unauthorised(res, 'Invalid email or password.');

const match = await bcrypt.compare(password, user.password_hash);
if (!match)  return unauthorised(res, 'Invalid email or password.');

const token = signToken({ id: user.id, email: user.email });
console.log('[Auth] Login:', user.email);

return ok(res, {
token,
user: { id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name },
});
}

// ── Register ──────────────────────────────────────────────────────────────────
async function handleRegister(req, res) {
const { firstName, lastName, email, password } = req.body;

if (!firstName || !lastName || !email || !password)
return badRequest(res, 'All fields are required.');
if (password.length < 8)
return badRequest(res, 'Password must be at least 8 characters.');

let existing;
try {
({ rows: existing } = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]));
} catch (err) {
return serverError(res, err);
}

if (existing.length) return badRequest(res, 'An account with this email already exists.');

const hash = await bcrypt.hash(password, 12);
let newUser;

try {
const { rows } = await query(
'INSERT INTO users (first_name, last_name, email, password_hash, credits) VALUES ($1, $2, $3, $4, 500) RETURNING id, email, first_name, last_name',
[firstName, lastName, email.toLowerCase(), hash]
);
newUser = rows[0];
} catch (err) {
return serverError(res, err);
}

const token = signToken({ id: newUser.id, email: newUser.email });
console.log('[Auth] Register:', newUser.email);

return ok(res, {
token,
user: { id: newUser.id, email: newUser.email, firstName: newUser.first_name, lastName: newUser.last_name },
});
}

// ── OTP — send ────────────────────────────────────────────────────────────────
async function handleSendOtp(req, res) {
const { phone } = req.body;
if (!phone) return badRequest(res, 'Phone number is required.');

// TODO: integrate your SMS provider here (Twilio, AWS SNS, etc.)
// For now we store a demo OTP in the DB.
const code = String(Math.floor(100000 + Math.random() * 900000));

try {
await query(
'INSERT INTO otp_codes (phone, code, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes') ON CONFLICT (phone) DO UPDATE SET code = $2, expires_at = NOW() + INTERVAL '10 minutes'',
[phone, code]
);
} catch (err) {
return serverError(res, err);
}

console.log('[Auth] OTP for', phone, ':', code, '(demo — send via SMS in production)');
return ok(res, { sent: true });
}

// ── OTP — verify ──────────────────────────────────────────────────────────────
async function handleVerifyOtp(req, res) {
const { phone, code } = req.body;
if (!phone || !code) return badRequest(res, 'Phone and code are required.');

let rows;
try {
({ rows } = await query(
'SELECT * FROM otp_codes WHERE phone = $1 AND code = $2 AND expires_at > NOW()',
[phone, code]
));
} catch (err) {
return serverError(res, err);
}

if (!rows.length) return unauthorised(res, 'Invalid or expired code.');

// Clean up used code
await query('DELETE FROM otp_codes WHERE phone = $1', [phone]).catch(() => {});

// Find or create user by phone
let user;
try {
const { rows: existing } = await query('SELECT * FROM users WHERE phone = $1', [phone]);
if (existing.length) {
user = existing[0];
} else {
const { rows: created } = await query(
'INSERT INTO users (phone, credits) VALUES ($1, 500) RETURNING *',
[phone]
);
user = created[0];
}
} catch (err) {
return serverError(res, err);
}

const token = signToken({ id: user.id, email: user.email ?? phone });
return ok(res, {
token,
user: { id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name },
});
}