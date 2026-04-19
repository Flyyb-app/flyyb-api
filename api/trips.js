/**
 * FLYYB API — api/trips.js
 *
 * GET  /api/trips                              — list user bookings
 * GET  /api/trips?status=confirmed|cancelled
 * POST /api/trips?action=cancel               { bookingRef }
 * POST /api/trips?action=reschedule-intent    { bookingRef, newDate, amount, originalPrice, newPrice }
 * POST /api/trips?action=reschedule           { bookingRef, newDate, paymentIntentId }
 */

var Stripe     = require('stripe');
var authLib    = require('../lib/auth');
var { pool }   = require('../lib/db');
var { handleCors } = require('../lib/cors');

module.exports = async function(req, res) {
  if (handleCors(req, res)) return;

  var user = authLib.requireAuth(req, res);
  if (!user) return;

  try {
    if (req.method === 'GET')  return await listTrips(req, res, user);
    if (req.method === 'POST') return await handlePost(req, res, user);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Trips]', err);
    res.status(500).json({ error: 'Request failed' });
  }
};

// ─── List bookings ─────────────────────────────────────────────────────────────
async function listTrips(req, res, user) {
  var status = ((req.query && req.query.status) || '').replace(/[^a-z]/g, '');
  var where  = status ? "AND b.status = '" + status + "'" : '';

  var client;
  try {
    client = await pool.connect();
    var r = await client.query(
      'SELECT b.booking_ref AS "bookingRef", b.status, b.total_paid AS total, b.cabin, ' +
      'b.dep_date AS date, b.dep_time AS departure, b.arr_time AS arrival, ' +
      'b.origin_code AS origin, b.dest_code AS destination, ' +
      'b.airline_code AS airline, b.flight_number AS "flightNumber" ' +
      "FROM bookings b WHERE b.user_id=$1 AND b.status != 'pending' " + where +
      ' ORDER BY b.created_at DESC LIMIT 50',
      [user.id]
    );

    var trips = r.rows.map(function(row) {
      return {
        bookingRef:  row.bookingRef,
        status:      row.status,
        total:       parseFloat(row.total) || 0,
        cabin:       row.cabin || 'economy',
        date:        row.date,
        departure:   row.departure ? String(row.departure).slice(0,5) : '',
        arrival:     row.arrival   ? String(row.arrival).slice(0,5)   : '',
        origin:      { code: row.origin },
        destination: { code: row.destination },
        flight:      { airline: { name: row.airline }, number: row.flightNumber },
      };
    });

    res.json(trips);
  } catch (err) {
    console.error('ListTrips:', err);
    res.status(500).json({ error: 'Failed to load trips' });
  } finally {
    if (client) client.release();
  }
}

// ─── POST dispatcher ───────────────────────────────────────────────────────────
async function handlePost(req, res, user) {
  var action     = (req.query && req.query.action) || (req.body && req.body.action) || '';
  var bookingRef = (req.body && req.body.bookingRef) || '';

  if (action === 'cancel')            return await cancelTrip(req, res, user, bookingRef);
  if (action === 'reschedule-intent') return await createRescheduleIntent(req, res, user);
  if (action === 'reschedule')        return await confirmReschedule(req, res, user);
  return res.status(400).json({ error: 'Unknown action: ' + action });
}

// ─── Cancel ────────────────────────────────────────────────────────────────────
async function cancelTrip(req, res, user, ref) {
  if (!ref) return res.status(400).json({ error: 'bookingRef is required' });

  var client, b;
  try {
    client = await pool.connect();
    var r = await client.query(
      'SELECT * FROM bookings WHERE booking_ref=$1 AND user_id=$2', [ref, user.id]
    );
    b = r.rows[0];
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    if (b.status === 'cancelled') return res.status(400).json({ error: 'Already cancelled' });

    var depDate = new Date(b.dep_date || Date.now() + 86400000);
    if (depDate < new Date()) return res.status(400).json({ error: 'Cannot cancel after departure' });

    await client.query("UPDATE bookings SET status='cancelled',updated_at=NOW() WHERE booking_ref=$1", [ref]);

    // Refund credits if any were used
    if (parseFloat(b.credits_used) > 0) {
      await client.query(
        'UPDATE credits SET balance=balance+$1 WHERE user_id=$2', [b.credits_used, user.id]
      ).catch(function(){});
    }

    console.log('[Trips] Cancelled', ref, 'for user', user.id);
    res.json({ cancelled: true, bookingRef: ref });
  } catch (err) {
    console.error('CancelTrip:', err);
    res.status(500).json({ error: 'Cancellation failed' });
  } finally {
    if (client) client.release();
  }
}

// ─── Reschedule Step 1: create PaymentIntent ──────────────────────────────────
// NEW: reschedule now requires payment (10% fee + price diff)
async function createRescheduleIntent(req, res, user) {
  var b             = req.body || {};
  var bookingRef    = b.bookingRef    || '';
  var newDate       = b.newDate       || '';
  var amount        = parseFloat(b.amount) || 0;
  var originalPrice = parseFloat(b.originalPrice) || 0;
  var newPrice      = parseFloat(b.newPrice) || 0;

  if (!bookingRef) return res.status(400).json({ error: 'bookingRef is required' });
  if (!newDate)    return res.status(400).json({ error: 'newDate is required' });
  if (amount <= 0) return res.status(400).json({ error: 'amount must be positive' });

  var stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Payment not configured' });
  var stripe = Stripe(stripeKey);

  var client;
  try {
    client = await pool.connect();
    var r = await client.query(
      'SELECT * FROM bookings WHERE booking_ref=$1 AND user_id=$2', [bookingRef, user.id]
    );
    var booking = r.rows[0];
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status === 'cancelled')   return res.status(400).json({ error: 'Cannot reschedule a cancelled booking' });
    if (booking.status === 'rescheduled') return res.status(400).json({ error: 'Booking already rescheduled' });

    var depDate = new Date(booking.dep_date || Date.now());
    if ((depDate - Date.now()) / 3600000 < 48)
      return res.status(400).json({ error: 'Must reschedule at least 48 hours before departure' });
    if (new Date(newDate) <= new Date())
      return res.status(400).json({ error: 'New date must be in the future' });

    var uRes  = await client.query('SELECT email FROM users WHERE id=$1', [user.id]);
    var email = uRes.rows[0] && uRes.rows[0].email;

    var intent = await stripe.paymentIntents.create({
      amount:        Math.round(amount),   // already in cents from frontend
      currency:      'usd',
      receipt_email: email || undefined,
      description:   'FLYYB reschedule fee — ' + bookingRef + ' to ' + newDate,
      metadata:      { type: 'reschedule', bookingRef: bookingRef, newDate: newDate, userId: String(user.id) },
    });

    res.json({ clientSecret: intent.client_secret, intentId: intent.id, amount: intent.amount });
  } catch (err) {
    console.error('RescheduleIntent:', err);
    res.status(500).json({ error: 'Reschedule payment setup failed' });
  } finally {
    if (client) client.release();
  }
}

// ─── Reschedule Step 2: confirm after Stripe payment ──────────────────────────
async function confirmReschedule(req, res, user) {
  var b               = req.body || {};
  var bookingRef      = b.bookingRef      || '';
  var newDate         = b.newDate         || '';
  var paymentIntentId = b.paymentIntentId || '';

  if (!bookingRef)      return res.status(400).json({ error: 'bookingRef is required' });
  if (!newDate)         return res.status(400).json({ error: 'newDate is required' });
  if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId is required' });

  var stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Payment not configured' });
  var stripe = Stripe(stripeKey);

  var intent;
  try {
    intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch (e) {
    return res.status(500).json({ error: 'Could not verify payment' });
  }

  if (intent.status !== 'succeeded')
    return res.status(400).json({ error: 'Payment not confirmed (status: ' + intent.status + ')' });
  if (intent.metadata && intent.metadata.bookingRef !== bookingRef)
    return res.status(403).json({ error: 'Payment does not match this booking' });

  var client;
  try {
    client = await pool.connect();
    var r = await client.query(
      'SELECT * FROM bookings WHERE booking_ref=$1 AND user_id=$2', [bookingRef, user.id]
    );
    var booking = r.rows[0];
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status === 'cancelled')   return res.status(400).json({ error: 'Cannot reschedule a cancelled booking' });
    if (booking.status === 'rescheduled') return res.status(400).json({ error: 'Already rescheduled' });

    await client.query(
      "UPDATE bookings SET status='rescheduled',dep_date=$1,updated_at=NOW() WHERE booking_ref=$2",
      [newDate, bookingRef]
    );

    // Log reschedule fee in credit_transactions
    await client.query(
      'INSERT INTO credit_transactions (user_id,description,amount,type,created_at) VALUES ($1,$2,$3,$4,NOW())',
      [user.id, 'Reschedule fee ' + bookingRef + ' to ' + newDate, -(intent.amount/100), 'reschedule_fee']
    ).catch(function(){});

    console.log('[Trips] Rescheduled', bookingRef, 'to', newDate);
    res.json({ rescheduled: true, bookingRef: bookingRef, newDate: newDate });
  } catch (err) {
    console.error('ConfirmReschedule:', err);
    res.status(500).json({ error: 'Reschedule confirmation failed' });
  } finally {
    if (client) client.release();
  }
}
