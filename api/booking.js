/**
 * FLYYB API — api/booking.js
 *
 * GET  /api/booking?action=credits       — credits balance + history
 * GET  /api/booking?action=addons        — available add-ons
 * POST /api/booking?action=create-intent — Stripe PaymentIntent + pending booking
 *                                          Also: awards credits, sends confirmation email
 */

var Stripe     = require('stripe');
var authLib    = require('../lib/auth');
var authModule = require('./auth');         // for sendBookingEmail
var { pool }   = require('../lib/db');

module.exports = async function(req, res) {
  if (authLib.cors(req, res)) return;

  var action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  try {
    if (action === 'addons')        return await getAddons(req, res);
    if (action === 'credits')       return await getCredits(req, res);
    if (action === 'create-intent') return await createIntent(req, res);
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    console.error('[Booking]', err);
    res.status(500).json({ error: 'Request failed' });
  }
};

// ─── Add-ons ───────────────────────────────────────────────────────────────────
async function getAddons(req, res) {
  res.json({
    addons: {
      baggage: [
        { code:'bag_23', name:'Extra 23kg Bag',   description:'Additional checked baggage',  price:45, icon:'🧳' },
        { code:'bag_32', name:'Extra 32kg Bag',   description:'Oversized checked baggage',   price:65, icon:'🧳' },
      ],
      seat: [
        { code:'seat_xl',   name:'Extra Legroom', description:'Up to 6 inches extra legroom', price:35, icon:'💺' },
        { code:'seat_exit', name:'Exit Row Seat', description:'Maximum space + priority exit', price:25, icon:'💺' },
      ],
      meal: [
        { code:'meal_veg',   name:'Vegetarian Meal', description:'Fresh vegetarian option', price:12, icon:'🍽️' },
        { code:'meal_vegan', name:'Vegan Meal',       description:'100% plant-based meal',  price:12, icon:'🍽️' },
        { code:'meal_child', name:'Child Meal',       description:'Kid-friendly meal',      price:8,  icon:'🍽️' },
      ],
      kit: [
        { code:'lounge',    name:'Airport Lounge', description:'Access to partner lounges', price:45, icon:'🎁' },
        { code:'fasttrack', name:'Fast Track',     description:'Priority security lane',    price:15, icon:'🎁' },
        { code:'wifi',      name:'In-flight WiFi', description:'High-speed internet',       price:18, icon:'🎁' },
      ],
    },
  });
}

// ─── Credits balance ───────────────────────────────────────────────────────────
async function getCredits(req, res) {
  var user = authLib.requireAuth(req, res);
  if (!user) return;
  var client;
  try {
    client = await pool.connect();
    var cr = await client.query('SELECT balance FROM credits WHERE user_id=$1', [user.id]);
    var tx = await client.query(
      'SELECT description,amount,type,created_at AS date FROM credit_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',
      [user.id]
    ).catch(function() { return { rows: [] }; });
    res.json({ balance: parseFloat((cr.rows[0]&&cr.rows[0].balance)||0), transactions: tx.rows });
  } catch (err) {
    console.error('GetCredits:', err);
    res.status(500).json({ error: 'Failed to load credits' });
  } finally {
    if (client) client.release();
  }
}

// ─── Create PaymentIntent ──────────────────────────────────────────────────────
async function createIntent(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var user = authLib.requireAuth(req, res);
  if (!user) return;

  var b            = req.body || {};
  var flightNumber = b.flightNumber  || '';
  var airlineCode  = b.airlineCode   || '';
  var originCode   = b.originCode    || '';
  var destCode     = b.destCode      || '';
  var depDate      = b.depDate       || '';
  var depTime      = b.depTime       || '';
  var arrTime      = b.arrTime       || '';
  var cabin        = b.cabin         || 'economy';
  var adults       = parseInt(b.adults) || 1;
  var passengers   = b.passengers    || [];
  var addons       = b.addons        || [];
  var baseAmount   = parseFloat(b.baseAmount)   || 0;
  var creditsToUse = parseFloat(b.creditsToUse) || 0;
  var confirmEmail = b.confirmationEmail || '';
  var returnFlight = b.returnFlight  || null;

  if (!flightNumber || !originCode || !destCode || !depDate)
    return res.status(400).json({ error: 'flightNumber, originCode, destCode and depDate are required' });

  var stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Payment not configured' });
  var stripe = Stripe(stripeKey);

  var client;
  try {
    client = await pool.connect();

    // Fetch user details for email and credits
    var uRes = await client.query(
      'SELECT id,name,email,default_currency FROM users WHERE id=$1', [user.id]
    );
    var uRow = uRes.rows[0] || {};

    // Validate and deduct credits
    var creditsUsed = 0;
    if (creditsToUse > 0) {
      var cr = await client.query('SELECT balance FROM credits WHERE user_id=$1', [user.id]);
      var available = parseFloat((cr.rows[0]&&cr.rows[0].balance)||0);
      creditsUsed = Math.min(creditsToUse, available);
      if (creditsUsed > 0) {
        await client.query('UPDATE credits SET balance=balance-$1 WHERE user_id=$2', [creditsUsed, user.id]);
      }
    }

    var total       = Math.max(0.5, baseAmount - creditsUsed);
    var amountCents = Math.round(total * 100);

    var intent = await stripe.paymentIntents.create({
      amount:        amountCents,
      currency:      (uRow.default_currency || 'USD').toLowerCase(),
      receipt_email: confirmEmail || uRow.email || undefined,
      description:   'FLYYB booking — ' + originCode + '->' + destCode + ' ' + depDate,
      metadata:      { userId: String(user.id), flightNumber: flightNumber, originCode: originCode, destCode: destCode, depDate: depDate, cabin: cabin },
    });

    var bookingRef = 'FLY' + Math.random().toString(36).slice(2,8).toUpperCase();

    // Persist booking
    try {
      await client.query(
        'INSERT INTO bookings (booking_ref,user_id,flight_number,airline_code,origin_code,dest_code,' +
        'dep_date,dep_time,arr_time,cabin,adults,passengers,addons,total_paid,credits_used,' +
        "stripe_intent_id,status,confirmation_email,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'confirmed',$17,NOW())",
        [bookingRef, user.id, flightNumber, airlineCode, originCode, destCode,
         depDate, depTime, arrTime, cabin, adults,
         JSON.stringify(passengers), JSON.stringify(addons),
         total, creditsUsed, intent.id, confirmEmail || uRow.email || null]
      );
    } catch (e) { console.error('Booking DB insert (non-fatal):', e.message); }

    // Award 5% credits
    var creditsToEarn = Math.round(total * 0.05 * 100) / 100;
    if (creditsToEarn > 0) {
      try {
        await client.query('UPDATE credits SET balance=balance+$1 WHERE user_id=$2', [creditsToEarn, user.id]);
        await client.query(
          "INSERT INTO credit_transactions (user_id,description,amount,type,created_at) VALUES ($1,$2,$3,'earn',NOW())",
          [user.id, 'Credits earned from booking ' + bookingRef, creditsToEarn]
        );
      } catch (e) { console.error('Credits award (non-fatal):', e.message); }
    }

    // Save passengers if checkbox checked (handled by frontend calling /api/profiles)
    // Nothing to do here — frontend calls savePassengersFromBooking separately

    // Send booking confirmation email
    var emailTo = confirmEmail || uRow.email || '';
    if (emailTo) {
      authModule.sendBookingEmail(emailTo, uRow.name, {
        ref: bookingRef, origin: originCode, dest: destCode,
        depDate: depDate, depTime: depTime, arrTime: arrTime,
        cabin: cabin, pax: adults, total: total,
        sym: uRow.default_currency === 'USD' ? '$' : uRow.default_currency,
      }).catch(function(e) { console.error('Booking email (non-fatal):', e.message); });
    }

    // Handle return flight booking if present
    if (returnFlight) {
      var rtRef = 'FLY' + Math.random().toString(36).slice(2,8).toUpperCase();
      try {
        await client.query(
          'INSERT INTO bookings (booking_ref,user_id,flight_number,airline_code,origin_code,dest_code,' +
          'dep_date,dep_time,arr_time,cabin,adults,passengers,addons,total_paid,credits_used,' +
          "stripe_intent_id,status,confirmation_email,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'confirmed',$17,NOW())",
          [rtRef, user.id, returnFlight.flightNumber, returnFlight.airlineCode,
           returnFlight.originCode, returnFlight.destCode,
           returnFlight.depDate, returnFlight.depTime||'', returnFlight.arrTime||'',
           cabin, adults, JSON.stringify(passengers), '[]',
           parseFloat(returnFlight.baseAmount)||0, 0, intent.id,
           confirmEmail || uRow.email || null]
        );
      } catch (e) { console.error('Return flight DB insert (non-fatal):', e.message); }
    }

    console.log('[Booking] Intent', intent.id, '| ref', bookingRef, '| $' + total);
    res.json({
      clientSecret: intent.client_secret,
      bookingRef:   bookingRef,
      summary:      { total: total, creditsUsed: creditsUsed, creditsToEarn: creditsToEarn },
    });
  } catch (err) {
    console.error('CreateIntent:', err);
    res.status(500).json({ error: 'Payment setup failed' });
  } finally {
    if (client) client.release();
  }
}
