/**
 * FLYYB API — api/profiles.js
 *
 * GET  /api/profiles?action=get               — full profile + saved passengers
 * GET  /api/profiles?action=passengers        — saved passengers list
 * GET  /api/profiles?action=currencies        — currency list (public)
 * POST /api/profiles?action=update            { name }
 * POST /api/profiles?action=change-currency   { currency }
 * POST /api/profiles?action=change-password   { currentPassword, newPassword }
 * POST /api/profiles?action=passengers        { firstName, lastName, dob, passportNo, isPrimary }
 * DELETE /api/profiles?action=passengers&id=  — remove a passenger
 * POST /api/profiles?action=delete-account    { password }
 *
 * DB schema: users.default_currency, users.flyyb_id
 */

var authLib    = require('../lib/auth');
var { pool }   = require('../lib/db');
var { handleCors } = require('../lib/cors');

var CURRENCIES_FALLBACK = [
  {code:'USD',name:'US Dollar',symbol:'$'},{code:'EUR',name:'Euro',symbol:'€'},
  {code:'GBP',name:'British Pound',symbol:'£'},{code:'INR',name:'Indian Rupee',symbol:'₹'},
  {code:'AUD',name:'Australian Dollar',symbol:'A$'},{code:'CAD',name:'Canadian Dollar',symbol:'C$'},
  {code:'SGD',name:'Singapore Dollar',symbol:'S$'},{code:'AED',name:'UAE Dirham',symbol:'AED'},
  {code:'JPY',name:'Japanese Yen',symbol:'¥'},{code:'MYR',name:'Malaysian Ringgit',symbol:'RM'},
  {code:'NZD',name:'New Zealand Dollar',symbol:'NZ$'},{code:'HKD',name:'Hong Kong Dollar',symbol:'HK$'},
  {code:'CHF',name:'Swiss Franc',symbol:'CHF'},{code:'THB',name:'Thai Baht',symbol:'฿'},
  {code:'QAR',name:'Qatari Riyal',symbol:'QAR'},{code:'SAR',name:'Saudi Riyal',symbol:'SAR'},
  {code:'KRW',name:'South Korean Won',symbol:'₩'},{code:'PKR',name:'Pakistani Rupee',symbol:'₨'},
  {code:'CNY',name:'Chinese Yuan',symbol:'¥'},{code:'IDR',name:'Indonesian Rupiah',symbol:'Rp'},
];

module.exports = async function(req, res) {
  if (handleCors(req, res)) return;

  var action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  // Currencies is public
  if (action === 'currencies') return await getCurrencies(req, res);

  var user = authLib.requireAuth(req, res);
  if (!user) return;

  try {
    if (req.method === 'GET') {
      if (action === 'passengers') return await getPassengers(req, res, user);
      return await getProfile(req, res, user);
    }
    if (req.method === 'DELETE') {
      if (action === 'passengers') return await deletePassenger(req, res, user);
    }
    if (req.method === 'POST') {
      if (action === 'update')           return await updateProfile(req, res, user);
      if (action === 'change-currency')  return await changeCurrency(req, res, user);
      if (action === 'change-password')  return await changePassword(req, res, user);
      if (action === 'passengers')       return await savePassenger(req, res, user);
      if (action === 'delete-account')   return await deleteAccount(req, res, user);
    }
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    console.error('[Profiles]', err);
    res.status(500).json({ error: 'Request failed' });
  }
};

// ─── Full profile ──────────────────────────────────────────────────────────────
async function getProfile(req, res, user) {
  var client;
  try {
    client = await pool.connect();
    var r = await client.query(
      'SELECT id,name,email,phone,is_active,email_verified,flyyb_id,default_currency,created_at FROM users WHERE id=$1',
      [user.id]
    );
    var u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });

    var credits = 0;
    try {
      var cr = await client.query('SELECT balance FROM credits WHERE user_id=$1', [u.id]);
      credits = parseFloat((cr.rows[0] && cr.rows[0].balance) || 0);
    } catch (e) {}

    var passengers = await client.query(
      'SELECT id,first_name,last_name,dob,passport_no,is_primary FROM passengers WHERE user_id=$1 ORDER BY is_primary DESC,id',
      [u.id]
    ).then(function(r2) { return r2.rows.map(safePassenger); }).catch(function() { return []; });

    res.json({
      id:            u.id,
      name:          u.name || (u.email || '').split('@')[0],
      email:         u.email || null,
      phone:         u.phone || null,
      currency:      u.default_currency || 'USD',
      credits:       credits,
      emailVerified: !!u.email_verified,
      flyybId:       u.flyyb_id || ('FLY' + String(u.id).padStart(6,'0')),
      passengers:    passengers,
    });
  } catch (err) {
    console.error('GetProfile:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  } finally {
    if (client) client.release();
  }
}

function safePassenger(p) {
  return {
    id:         p.id,
    firstName:  p.first_name  || '',
    lastName:   p.last_name   || '',
    dob:        p.dob         || null,
    passportNo: p.passport_no || null,
    isPrimary:  !!p.is_primary,
  };
}

// ─── Passengers list ───────────────────────────────────────────────────────────
async function getPassengers(req, res, user) {
  var client;
  try {
    client = await pool.connect();
    var r = await client.query(
      'SELECT id,first_name,last_name,dob,passport_no,is_primary FROM passengers WHERE user_id=$1 ORDER BY is_primary DESC,id',
      [user.id]
    );
    res.json(r.rows.map(safePassenger));
  } catch (err) {
    console.error('GetPassengers:', err);
    res.json([]); // non-fatal fallback
  } finally {
    if (client) client.release();
  }
}

// ─── Currencies (public, with static fallback) ─────────────────────────────────
async function getCurrencies(req, res) {
  var client;
  try {
    client = await pool.connect();
    var r = await client.query('SELECT code,name,symbol FROM currencies ORDER BY code');
    if (r.rows.length) return res.json(r.rows);
  } catch (e) {} finally {
    if (client) client.release();
  }
  res.json(CURRENCIES_FALLBACK);
}

// ─── Update name ───────────────────────────────────────────────────────────────
async function updateProfile(req, res, user) {
  var name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  var client;
  try {
    client = await pool.connect();
    await client.query('UPDATE users SET name=$1 WHERE id=$2', [name, user.id]);
    res.json({ updated: true });
  } catch (err) {
    console.error('UpdateProfile:', err);
    res.status(500).json({ error: 'Update failed' });
  } finally {
    if (client) client.release();
  }
}

// ─── Change currency ───────────────────────────────────────────────────────────
async function changeCurrency(req, res, user) {
  var currency = (req.body && req.body.currency) || '';
  if (!currency) return res.status(400).json({ error: 'currency is required' });
  var client;
  try {
    client = await pool.connect();
    await client.query('UPDATE users SET default_currency=$1 WHERE id=$2', [currency, user.id]);
    res.json({ updated: true, currency: currency });
  } catch (err) {
    console.error('ChangeCurrency:', err);
    res.status(500).json({ error: 'Update failed' });
  } finally {
    if (client) client.release();
  }
}

// ─── Change password ───────────────────────────────────────────────────────────
async function changePassword(req, res, user) {
  var b         = req.body || {};
  var currentPw = b.currentPassword || '';
  var newPw     = b.newPassword     || '';
  if (!currentPw || !newPw) return res.status(400).json({ error: 'Both passwords required' });
  var client;
  try {
    client = await pool.connect();
    var r  = await client.query('SELECT password_hash FROM users WHERE id=$1', [user.id]);
    var u  = r.rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    var match = await authLib.verifyPassword(currentPw, u.password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
    var hash = await authLib.hashPassword(newPw);
    await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, user.id]);
    res.json({ updated: true });
  } catch (err) {
    console.error('ChangePassword:', err);
    res.status(500).json({ error: 'Password update failed' });
  } finally {
    if (client) client.release();
  }
}

// ─── Save passenger ────────────────────────────────────────────────────────────
async function savePassenger(req, res, user) {
  var b         = req.body || {};
  var firstName  = b.firstName  || '';
  var lastName   = b.lastName   || '';
  var dob        = b.dob        || null;
  var passportNo = b.passportNo || null;
  var isPrimary  = !!b.isPrimary;
  if (!firstName || !lastName) return res.status(400).json({ error: 'First and last name required' });

  var client;
  try {
    client = await pool.connect();
    if (isPrimary) {
      await client.query('UPDATE passengers SET is_primary=FALSE WHERE user_id=$1', [user.id]).catch(function(){});
    }
    var r = await client.query(
      'INSERT INTO passengers (user_id,first_name,last_name,dob,passport_no,is_primary) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [user.id, firstName, lastName, dob, passportNo, isPrimary]
    );
    res.json({ saved: true, id: r.rows[0].id });
  } catch (err) {
    console.error('SavePassenger:', err);
    res.status(500).json({ error: 'Failed to save passenger' });
  } finally {
    if (client) client.release();
  }
}

// ─── Delete passenger ──────────────────────────────────────────────────────────
async function deletePassenger(req, res, user) {
  var id = (req.query && req.query.id) || (req.body && req.body.id);
  if (!id) return res.status(400).json({ error: 'id is required' });
  var client;
  try {
    client = await pool.connect();
    await client.query('DELETE FROM passengers WHERE id=$1 AND user_id=$2', [id, user.id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error('DeletePassenger:', err);
    res.status(500).json({ error: 'Delete failed' });
  } finally {
    if (client) client.release();
  }
}

// ─── Delete account ────────────────────────────────────────────────────────────
async function deleteAccount(req, res, user) {
  var client;
  try {
    client = await pool.connect();
    await client.query('DELETE FROM users WHERE id=$1', [user.id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error('DeleteAccount:', err);
    res.status(500).json({ error: 'Delete failed' });
  } finally {
    if (client) client.release();
  }
}
