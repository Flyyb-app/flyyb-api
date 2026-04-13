/**

- FLYYB API — api/profiles.js
- 
- GET /api/profiles             → full profile (session restore)
- GET /api/profiles?section=credits → credits balance + transaction log
- 
- Requires: Authorization: Bearer <token>
  */

const { query }      = require('../lib/db');
const { requireAuth }   = require('../lib/auth');
const { handleCors }    = require('../lib/cors');
const { ok, notFound, serverError, wrap } = require('../lib/respond');

module.exports = wrap(async (req, res) => {
if (handleCors(req, res)) return;

const user = requireAuth(req, res);
if (!user) return;   // 401 already sent

const section = req.query?.section;

if (section === 'credits') return getCredits(req, res, user);
return getProfile(req, res, user);
});

// ── Full profile ──────────────────────────────────────────────────────────────
async function getProfile(req, res, user) {
let rows;
try {
({ rows } = await query(
'SELECT id, email, first_name, last_name, phone, credits, created_at FROM users WHERE id = $1',
[user.id]
));
} catch (err) {
return serverError(res, err);
}

if (!rows.length) return notFound(res, 'User not found.');

const u = rows[0];
return ok(res, {
user: {
id:        u.id,
email:     u.email,
firstName: u.first_name,
lastName:  u.last_name,
phone:     u.phone,
credits:   u.credits,
memberSince: u.created_at,
},
});
}

// ── Credits ───────────────────────────────────────────────────────────────────
async function getCredits(req, res, user) {
let userRow, txRows;
try {
({ rows: [userRow] } = await query('SELECT credits FROM users WHERE id = $1', [user.id]));
({ rows: txRows }    = await query(
'SELECT description, amount, type, created_at FROM credit_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
[user.id]
));
} catch (err) {
return serverError(res, err);
}

return ok(res, {
credits:      userRow?.credits ?? 0,
transactions: txRows,
});
}