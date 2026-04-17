/**
 * FLYYB API — api/profiles.js
 *
 * GET  /api/profiles?action=get               — full profile
 * GET  /api/profiles?action=passengers        — saved passengers list
 * GET  /api/profiles?action=currencies        — available currencies (public)
 * POST /api/profiles?action=update            — update name
 * POST /api/profiles?action=change-currency   — change default currency
 * POST /api/profiles?action=change-password   — change password
 * POST /api/profiles?action=passengers        — save a passenger
 * POST /api/profiles?action=delete-passenger  — delete a passenger { id }
 * POST /api/profiles?action=delete-account    — delete account
 *
 * Env vars: DATABASE_URL, JWT_SECRET
 */
const bcrypt         = require('bcryptjs');
const { query }      = require('../lib/db');
const { requireAuth }   = require('../lib/auth');
const { handleCors }    = require('../lib/cors');
const { ok, badRequest, serverError, wrap } = require('../lib/respond');

module.exports = wrap(async (req, res) => {
  if (handleCors(req, res)) return;

  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  // Currencies is public — no auth needed
  if (action === 'currencies') return getCurrencies(req, res);

  const user = requireAuth(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    if (action === 'get'        || action === '') return getProfile(req, res, user);
    if (action === 'passengers')                  return getPassengers(req, res, user);
    return getProfile(req, res, user);
  }

  if (req.method === 'POST') {
    if (action === 'update')           return updateProfile(req, res, user);
    if (action === 'change-currency')  return changeCurrency(req, res, user);
    if (action === 'change-password')  return changePassword(req, res, user);
    if (action === 'passengers')       return savePassenger(req, res, user);
    if (action === 'delete-passenger') return deletePassenger(req, res, user);
    if (action === 'delete-account')   return deleteAccount(req, res, user);
  }

  return badRequest(res, 'Unknown action: "' + action + '"');
});

// ── Full profile ──────────────────────────────────────────────────────────────
async function getProfile(req, res, user) {
  try {
    var result = await query(
      'SELECT id,name,email,phone,currency,credits,email_verified,created_at FROM users WHERE id=$1',
      [user.id]
    );
    var u = result.rows[0];
    if (!u) return ok(res, {});

    var pResult = await query(
      'SELECT id,first_name AS "firstName",last_name AS "lastName",dob,passport_no AS "passportNo",is_primary AS "isPrimary" FROM passengers WHERE user_id=$1 ORDER BY is_primary DESC,id',
      [user.id]
    ).catch(function() { return { rows: [] }; });

    return ok(res, {
      id:            u.id,
      name:          u.name,
      email:         u.email,
      phone:         u.phone,
      currency:      u.currency || 'USD',
      credits:       parseFloat(u.credits) || 0,
      emailVerified: u.email_verified,
      flyybId:       'FLY' + String(u.id).padStart(6, '0'),
      passengers:    pResult.rows,
    });
  } catch (err) { return serverError(res, err); }
}

// ── Saved passengers ──────────────────────────────────────────────────────────
async function getPassengers(req, res, user) {
  try {
    var result = await query(
      'SELECT id,first_name AS "firstName",last_name AS "lastName",dob,passport_no AS "passportNo",is_primary AS "isPrimary" FROM passengers WHERE user_id=$1 ORDER BY is_primary DESC,id',
      [user.id]
    );
    return ok(res, result.rows);
  } catch (err) {
    // Table may not exist yet — return empty
    return ok(res, []);
  }
}

// ── Currencies (public) ───────────────────────────────────────────────────────
async function getCurrencies(req, res) {
  try {
    var result = await query('SELECT code,name,symbol FROM currencies ORDER BY code');
    return ok(res, result.rows);
  } catch (err) {
    // Fallback static list
    return ok(res, [
      { code:'USD', name:'US Dollar',          symbol:'$'   },
      { code:'EUR', name:'Euro',               symbol:'€'   },
      { code:'GBP', name:'British Pound',      symbol:'£'   },
      { code:'INR', name:'Indian Rupee',       symbol:'₹'   },
      { code:'AUD', name:'Australian Dollar',  symbol:'A$'  },
      { code:'CAD', name:'Canadian Dollar',    symbol:'C$'  },
      { code:'SGD', name:'Singapore Dollar',   symbol:'S$'  },
      { code:'AED', name:'UAE Dirham',         symbol:'AED' },
      { code:'JPY', name:'Japanese Yen',       symbol:'¥'   },
      { code:'MYR', name:'Malaysian Ringgit',  symbol:'RM'  },
      { code:'NZD', name:'New Zealand Dollar', symbol:'NZ$' },
      { code:'HKD', name:'Hong Kong Dollar',   symbol:'HK$' },
      { code:'CHF', name:'Swiss Franc',        symbol:'CHF' },
      { code:'THB', name:'Thai Baht',          symbol:'฿'   },
      { code:'QAR', name:'Qatari Riyal',       symbol:'QAR' },
      { code:'SAR', name:'Saudi Riyal',        symbol:'SAR' },
    ]);
  }
}

// ── Update name ───────────────────────────────────────────────────────────────
async function updateProfile(req, res, user) {
  var name = (req.body && req.body.name || '').trim();
  if (!name) return badRequest(res, 'Name is required.');
  try {
    await query('UPDATE users SET name=$1,updated_at=NOW() WHERE id=$2', [name, user.id]);
    return ok(res, { updated: true });
  } catch (err) { return serverError(res, err); }
}

// ── Change currency ───────────────────────────────────────────────────────────
async function changeCurrency(req, res, user) {
  var currency = req.body && req.body.currency || '';
  if (!currency) return badRequest(res, 'currency is required.');
  try {
    await query('UPDATE users SET currency=$1 WHERE id=$2', [currency, user.id]);
    return ok(res, { updated: true, currency: currency });
  } catch (err) { return serverError(res, err); }
}

// ── Change password ───────────────────────────────────────────────────────────
async function changePassword(req, res, user) {
  var body            = req.body || {};
  var currentPassword = body.currentPassword || '';
  var newPassword     = body.newPassword     || '';
  if (!currentPassword || !newPassword) return badRequest(res, 'Both current and new password required.');
  if (newPassword.length < 8 && !body._enc) return badRequest(res, 'Password must be 8+ characters.');
  try {
    var result = await query('SELECT password_hash FROM users WHERE id=$1', [user.id]);
    var u      = result.rows[0];
    var match  = await bcrypt.compare(currentPassword, u.password_hash);
    if (!match) return badRequest(res, 'Current password is incorrect.');
    var hash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash=$1,updated_at=NOW() WHERE id=$2', [hash, user.id]);
    return ok(res, { updated: true });
  } catch (err) { return serverError(res, err); }
}

// ── Save passenger ────────────────────────────────────────────────────────────
async function savePassenger(req, res, user) {
  var body       = req.body || {};
  var firstName  = body.firstName  || '';
  var lastName   = body.lastName   || '';
  var dob        = body.dob        || null;
  var passportNo = body.passportNo || null;
  var isPrimary  = !!body.isPrimary;
  if (!firstName || !lastName) return badRequest(res, 'First and last name are required.');
  try {
    if (isPrimary) {
      await query('UPDATE passengers SET is_primary=false WHERE user_id=$1', [user.id]);
    }
    var result = await query(
      'INSERT INTO passengers (user_id,first_name,last_name,dob,passport_no,is_primary) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [user.id, firstName, lastName, dob, passportNo, isPrimary]
    );
    return ok(res, { saved: true, id: result.rows[0].id });
  } catch (err) { return serverError(res, err); }
}

// ── Delete passenger ──────────────────────────────────────────────────────────
async function deletePassenger(req, res, user) {
  var id = req.body && req.body.id;
  if (!id) return badRequest(res, 'id is required.');
  try {
    await query('DELETE FROM passengers WHERE id=$1 AND user_id=$2', [id, user.id]);
    return ok(res, { deleted: true });
  } catch (err) { return serverError(res, err); }
}

// ── Delete account ────────────────────────────────────────────────────────────
async function deleteAccount(req, res, user) {
  try {
    await query('DELETE FROM users WHERE id=$1', [user.id]);
    return ok(res, { deleted: true });
  } catch (err) { return serverError(res, err); }
}
