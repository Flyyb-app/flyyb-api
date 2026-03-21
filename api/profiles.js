var pg = require('pg');
var authLib = require('../lib/auth');
var pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── GET PROFILE ───────────────────────────────────────────────
async function handleGetProfile(req, res) {
  var payload = authLib.requireAuth(req, res);
  if (!payload) return;
  var client;
  try {
    client = await pool.connect();
    var [userRes, creditsRes, passRes] = await Promise.all([
      client.query('SELECT u.id,u.name,u.email,u.phone,u.flyyb_id,u.default_currency,u.email_verified,u.auth_provider,u.created_at,c.balance FROM users u LEFT JOIN credits c ON c.user_id=u.id WHERE u.id=$1',[payload.sub]),
      client.query('SELECT amount,type,description,booking_ref,created_at FROM credit_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10',[payload.sub]),
      client.query('SELECT id,first_name,last_name,date_of_birth,nationality,passport_no,email,phone,is_primary FROM passenger_profiles WHERE user_id=$1 ORDER BY is_primary DESC,id ASC',[payload.sub])
    ]);
    var u = userRes.rows[0];
    if (!u) return res.status(404).json({ error:'User not found' });

    // Mask email and phone
    var email = u.email||'';
    var maskedEmail = email.length>3 ? email.slice(0,2)+'***'+email.slice(email.indexOf('@')) : '***';
    var phone = u.phone||'';
    var maskedPhone = phone.length>4 ? '****'+phone.slice(-4) : '****';

    res.json({
      flyybId:       u.flyyb_id,
      name:          u.name,
      email:         maskedEmail,
      emailFull:     email,
      phone:         maskedPhone,
      phoneFull:     phone,
      currency:      u.default_currency,
      emailVerified: u.email_verified,
      provider:      u.auth_provider,
      joined:        u.created_at,
      credits: {
        balance:      parseFloat(u.balance||0),
        transactions: creditsRes.rows.map(function(t) {
          return { amount:parseFloat(t.amount), type:t.type, description:t.description, bookingRef:t.booking_ref, date:t.created_at };
        })
      },
      passengers: passRes.rows.map(function(p) {
        return { id:p.id, firstName:p.first_name, lastName:p.last_name, dob:p.date_of_birth, nationality:p.nationality, passportNo:p.passport_no, email:p.email, phone:p.phone, isPrimary:p.is_primary };
      })
    });
  } catch(err) {
    console.error('Profile error:',err);
    res.status(500).json({ error:'Failed to load profile' });
  } finally { if(client) client.release(); }
}

// ── UPDATE PROFILE ────────────────────────────────────────────
async function handleUpdateProfile(req, res) {
  var payload = authLib.requireAuth(req, res);
  if (!payload) return;
  var b = req.body || {};
  var client;
  try {
    client = await pool.connect();
    var updates = [], params = [], idx = 1;
    if (b.name)  { updates.push('name=$'+idx); params.push(b.name.trim()); idx++; }
    if (b.phone) { updates.push('phone=$'+idx); params.push(b.phone); idx++; }
    if (!updates.length) return res.status(400).json({ error:'Nothing to update' });
    params.push(payload.sub);
    await client.query('UPDATE users SET '+updates.join(',')+', updated_at=NOW() WHERE id=$'+idx, params);
    res.json({ message:'Profile updated' });
  } catch(err) {
    console.error('Update profile error:',err);
    res.status(500).json({ error:'Update failed' });
  } finally { if(client) client.release(); }
}

// ── CHANGE PASSWORD ───────────────────────────────────────────
async function handleChangePassword(req, res) {
  var payload = authLib.requireAuth(req, res);
  if (!payload) return;
  var b = req.body || {};
  if (!b.currentPassword||!b.newPassword) return res.status(400).json({ error:'Current and new password required' });
  if (b.newPassword.length<8) return res.status(400).json({ error:'New password must be at least 8 characters' });

  function isStrong(pw) {
    var h=false,u=false,d=false;
    for (var c of pw) { if(c>='a'&&c<='z')h=true; if(c>='A'&&c<='Z')u=true; if(c>='0'&&c<='9')d=true; }
    return h&&u&&d;
  }
  if (!isStrong(b.newPassword)) return res.status(400).json({ error:'Password needs uppercase, lowercase and a number' });

  var client;
  try {
    client = await pool.connect();
    var r = await client.query('SELECT password_hash FROM users WHERE id=$1',[payload.sub]);
    var user = r.rows[0];
    if (!user) return res.status(404).json({ error:'User not found' });
    var valid = await authLib.verifyPassword(b.currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error:'Current password is incorrect' });
    var newHash = await authLib.hashPassword(b.newPassword);
    await client.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2',[newHash,payload.sub]);
    res.json({ message:'Password changed successfully' });
  } catch(err) {
    console.error('Change password error:',err);
    res.status(500).json({ error:'Password change failed' });
  } finally { if(client) client.release(); }
}

// ── CHANGE CURRENCY ───────────────────────────────────────────
async function handleChangeCurrency(req, res) {
  var payload = authLib.requireAuth(req, res);
  if (!payload) return;
  var b = req.body || {};
  if (!b.currency||b.currency.length!==3) return res.status(400).json({ error:'Valid currency code required' });

  var client;
  try {
    client = await pool.connect();
    var curCheck = await client.query('SELECT code FROM currencies WHERE code=$1',[b.currency]);
    if (!curCheck.rows.length) return res.status(400).json({ error:'Invalid currency' });

    // Get current currency to check if different
    var userRes = await client.query('SELECT default_currency FROM users WHERE id=$1',[payload.sub]);
    var currentCurrency = userRes.rows[0]&&userRes.rows[0].default_currency;
    if (currentCurrency!==b.currency) {
      // Changing currency - note credits cannot be used in future until changed back
      await client.query('UPDATE users SET default_currency=$1, updated_at=NOW() WHERE id=$2',[b.currency,payload.sub]);
      res.json({ message:'Currency changed to '+b.currency, warning:'Note: Changing currency means existing credits cannot be redeemed until you change back to your original currency.' });
    } else {
      res.json({ message:'Currency is already '+b.currency });
    }
  } catch(err) {
    console.error('Change currency error:',err);
    res.status(500).json({ error:'Currency change failed' });
  } finally { if(client) client.release(); }
}

// ── PASSENGERS CRUD ───────────────────────────────────────────
async function handlePassengers(req, res) {
  var payload = authLib.requireAuth(req, res);
  if (!payload) return;
  var client;
  try {
    client = await pool.connect();
    if (req.method==='GET') {
      var r = await client.query('SELECT id,first_name,last_name,date_of_birth,nationality,passport_no,passport_exp,email,phone,is_primary FROM passenger_profiles WHERE user_id=$1 ORDER BY is_primary DESC,id ASC',[payload.sub]);
      return res.json(r.rows.map(function(p) {
        return { id:p.id, firstName:p.first_name, lastName:p.last_name, dob:p.date_of_birth, nationality:p.nationality, passportNo:p.passport_no, passportExp:p.passport_exp, email:p.email, phone:p.phone, isPrimary:p.is_primary };
      }));
    }
    if (req.method==='POST') {
      var b = req.body||{};
      if (!b.firstName||!b.lastName) throw { status:400, message:'First and last name required' };
      if (b.isPrimary) await client.query('UPDATE passenger_profiles SET is_primary=FALSE WHERE user_id=$1',[payload.sub]);
      var r = await client.query('INSERT INTO passenger_profiles (user_id,first_name,last_name,date_of_birth,nationality,passport_no,passport_exp,email,phone,is_primary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',[payload.sub,b.firstName,b.lastName,b.dob||null,b.nationality||null,b.passportNo||null,b.passportExp||null,b.email||null,b.phone||null,b.isPrimary||false]);
      return res.status(201).json({ id:r.rows[0].id, message:'Passenger saved' });
    }
    if (req.method==='PUT') {
      var b = req.body||{}, id=req.query.id;
      if (!id) throw { status:400, message:'ID required' };
      if (b.isPrimary) await client.query('UPDATE passenger_profiles SET is_primary=FALSE WHERE user_id=$1',[payload.sub]);
      await client.query('UPDATE passenger_profiles SET first_name=$1,last_name=$2,date_of_birth=$3,nationality=$4,passport_no=$5,email=$6,phone=$7,is_primary=$8,updated_at=NOW() WHERE id=$9 AND user_id=$10',[b.firstName,b.lastName,b.dob||null,b.nationality||null,b.passportNo||null,b.email||null,b.phone||null,b.isPrimary||false,id,payload.sub]);
      return res.json({ message:'Passenger updated' });
    }
    if (req.method==='DELETE') {
      var id = req.query.id;
      if (!id) throw { status:400, message:'ID required' };
      var r = await client.query('DELETE FROM passenger_profiles WHERE id=$1 AND user_id=$2',[id,payload.sub]);
      if (!r.rowCount) throw { status:404, message:'Not found' };
      return res.json({ message:'Deleted' });
    }
    res.status(405).json({ error:'Method not allowed' });
  } catch(err) {
    if (err.status) return res.status(err.status).json({ error:err.message });
    console.error('Passengers error:',err);
    res.status(500).json({ error:'Operation failed' });
  } finally { if(client) client.release(); }
}

// ── DELETE ACCOUNT ────────────────────────────────────────────
async function handleDeleteAccount(req, res) {
  var payload = authLib.requireAuth(req, res);
  if (!payload) return;
  var b = req.body||{};
  if (!b.password) return res.status(400).json({ error:'Password required to delete account' });
  var client;
  try {
    client = await pool.connect();
    var r = await client.query('SELECT password_hash FROM users WHERE id=$1',[payload.sub]);
    if (!r.rows.length) return res.status(404).json({ error:'User not found' });
    var valid = await authLib.verifyPassword(b.password, r.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error:'Incorrect password' });
    // Soft delete
    await client.query('UPDATE users SET is_active=FALSE, email=email||$1, updated_at=NOW() WHERE id=$2',['_deleted_'+Date.now(),payload.sub]);
    await client.query('UPDATE refresh_tokens SET revoked=TRUE WHERE user_id=$1',[payload.sub]);
    res.json({ message:'Account deleted successfully' });
  } catch(err) {
    console.error('Delete account error:',err);
    res.status(500).json({ error:'Account deletion failed' });
  } finally { if(client) client.release(); }
}

// ── CURRENCIES LIST ───────────────────────────────────────────
async function handleCurrencies(req, res) {
  try {
    var client = await pool.connect();
    var r = await client.query('SELECT code,name,symbol,rate_usd FROM currencies ORDER BY code');
    client.release();
    res.json(r.rows);
  } catch(err) {
    res.status(500).json({ error:'Failed to fetch currencies' });
  }
}

// ── ROUTER ────────────────────────────────────────────────────
module.exports = function(req, res) {
  if (authLib.cors(req, res)) return;
  var action = req.query.action;
  if (action==='currencies')       return handleCurrencies(req, res);
  if (action==='get')              return handleGetProfile(req, res);
  if (action==='update')           return handleUpdateProfile(req, res);
  if (action==='change-password')  return handleChangePassword(req, res);
  if (action==='change-currency')  return handleChangeCurrency(req, res);
  if (action==='passengers')       return handlePassengers(req, res);
  if (action==='delete-account')   return handleDeleteAccount(req, res);
  return res.status(400).json({ error:'Missing action' });
};
