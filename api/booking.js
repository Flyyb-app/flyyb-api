/**
 * FLYYB API — api/booking.js
 *
 * POST /api/booking?action=create-intent   — create Stripe PaymentIntent + pending booking
 * GET  /api/booking?action=credits         — user credits balance + transaction history
 * GET  /api/booking?action=addons          — available add-ons for an airline
 *
 * Env vars: STRIPE_SECRET_KEY, DATABASE_URL
 */
const Stripe         = require('stripe');
const { query }      = require('../lib/db');
const { requireAuth }   = require('../lib/auth');
const { handleCors }    = require('../lib/cors');
const { ok, badRequest, serverError, wrap } = require('../lib/respond');

module.exports = wrap(async (req, res) => {
  if (handleCors(req, res)) return;

  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  if (action === 'credits') {
    const user = requireAuth(req, res);
    if (!user) return;
    return getCredits(req, res, user);
  }

  if (action === 'addons') {
    return getAddons(req, res);
  }

  if (action === 'create-intent') {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed.' });
    const user = requireAuth(req, res);
    if (!user) return;
    return createIntent(req, res, user);
  }

  return badRequest(res, 'Unknown action: "' + action + '"');
});

// ── Credits ───────────────────────────────────────────────────────────────────
async function getCredits(req, res, user) {
  try {
    const uResult  = await query('SELECT credits FROM users WHERE id=$1', [user.id]);
    const txResult = await query(
      'SELECT description,amount,type,created_at AS date FROM credit_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',
      [user.id]
    );
    return ok(res, {
      balance:      parseFloat((uResult.rows[0] && uResult.rows[0].credits) || 0),
      transactions: txResult.rows,
    });
  } catch (err) { return serverError(res, err); }
}

// ── Add-ons ───────────────────────────────────────────────────────────────────
async function getAddons(req, res) {
  return ok(res, {
    addons: {
      baggage: [
        { code:'bag_23',  name:'Extra 23kg Bag',   description:'Additional checked baggage',    price:45,  icon:'\uD83E\uDDF3' },
        { code:'bag_32',  name:'Extra 32kg Bag',   description:'Oversized checked baggage',     price:65,  icon:'\uD83E\uDDF3' },
      ],
      seat: [
        { code:'seat_xl',   name:'Extra Legroom', description:'Up to 6 inches extra legroom', price:35, icon:'\uD83D\uDCBA' },
        { code:'seat_exit', name:'Exit Row Seat', description:'Maximum space + priority exit', price:25, icon:'\uD83D\uDCBA' },
      ],
      meal: [
        { code:'meal_veg',   name:'Vegetarian Meal', description:'Fresh vegetarian option', price:12, icon:'\uD83C\uDF7D\uFE0F' },
        { code:'meal_vegan', name:'Vegan Meal',       description:'100% plant-based meal',  price:12, icon:'\uD83C\uDF7D\uFE0F' },
        { code:'meal_child', name:'Child Meal',       description:'Kid-friendly meal',      price:8,  icon:'\uD83C\uDF7D\uFE0F' },
      ],
      kit: [
        { code:'lounge',    name:'Airport Lounge', description:'Access to partner lounges', price:45, icon:'\uD83C\uDF81' },
        { code:'fasttrack', name:'Fast Track',     description:'Priority security lane',    price:15, icon:'\uD83C\uDF81' },
        { code:'wifi',      name:'In-flight WiFi', description:'High-speed internet',       price:18, icon:'\uD83C\uDF81' },
      ],
    },
  });
}

// ── Create PaymentIntent ──────────────────────────────────────────────────────
async function createIntent(req, res, user) {
  var body               = req.body || {};
  var flightNumber       = body.flightNumber || '';
  var airlineCode        = body.airlineCode  || '';
  var originCode         = body.originCode   || '';
  var destCode           = body.destCode     || '';
  var depDate            = body.depDate      || '';
  var depTime            = body.depTime      || '';
  var arrTime            = body.arrTime      || '';
  var cabin              = body.cabin        || 'economy';
  var adults             = body.adults       || 1;
  var passengers         = body.passengers   || [];
  var addons             = body.addons       || [];
  var baseAmount         = parseFloat(body.baseAmount) || 0;
  var creditsToUse       = parseFloat(body.creditsToUse) || 0;
  var confirmationEmail  = body.confirmationEmail || '';
  var returnFlight       = body.returnFlight || null;

  if (!flightNumber || !originCode || !destCode || !depDate)
    return badRequest(res, 'flightNumber, originCode, destCode and depDate are required.');

  var stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return serverError(res, new Error('STRIPE_SECRET_KEY not set'));
  var stripe = Stripe(stripeKey);

  var creditsUsed = Math.max(0, creditsToUse);
  var total       = Math.max(0.5, baseAmount - creditsUsed);
  var amountCents = Math.round(total * 100);

  // Deduct credits
  if (creditsUsed > 0) {
    try {
      await query('UPDATE users SET credits=GREATEST(0,credits-$1) WHERE id=$2', [creditsUsed, user.id]);
    } catch (e) { console.warn('[Booking] Credit deduct warning:', e.message); }
  }

  var intent;
  try {
    intent = await stripe.paymentIntents.create({
      amount:        amountCents,
      currency:      'usd',
      receipt_email: confirmationEmail || undefined,
      description:   'FLYYB booking — ' + originCode + '->' + destCode + ' ' + depDate,
      metadata:      { userId: String(user.id), flightNumber: flightNumber, originCode: originCode, destCode: destCode, depDate: depDate, cabin: cabin },
    });
  } catch (err) {
    console.error('[Booking] Stripe error:', err.message);
    return serverError(res, err, 'Could not initialise payment. Please try again.');
  }

  var bookingRef = 'FLY' + Math.random().toString(36).slice(2, 8).toUpperCase();

  try {
    await query(
      "INSERT INTO bookings (booking_ref,user_id,flight_number,airline_code,origin_code,dest_code,dep_date,dep_time,arr_time,cabin,adults,passengers,addons,total_paid,credits_used,currency,stripe_intent_id,status,confirmation_email,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'USD',$16,'pending',$17,NOW())",
      [bookingRef, user.id, flightNumber, airlineCode, originCode, destCode,
       depDate, depTime, arrTime, cabin, adults || 1,
       JSON.stringify(passengers), JSON.stringify(addons),
       total, creditsUsed, intent.id, confirmationEmail || null]
    );
  } catch (err) { console.warn('[Booking] DB insert warning (non-fatal):', err.message); }

  var creditsToEarn = Math.round(total * 0.05 * 100) / 100;

  console.log('[Booking] Intent', intent.id, '| ref', bookingRef, '| $' + total);
  return ok(res, {
    clientSecret: intent.client_secret,
    bookingRef:   bookingRef,
    summary:      { total: total, creditsUsed: creditsUsed, creditsToEarn: creditsToEarn },
  });
}
