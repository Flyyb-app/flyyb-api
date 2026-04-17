/**
 * FLYYB API — api/trips.js
 *
 * GET  /api/trips                                  → list user bookings
 * POST /api/trips { action: 'cancel',              bookingRef }
 * POST /api/trips { action: 'reschedule',          bookingRef, newDate, paymentIntentId }
 * POST /api/trips { action: 'reschedule-intent',   bookingRef, newDate, amount, originalPrice, newPrice }
 *
 * Requires: Authorization: Bearer <token>
 */

const Stripe        = require('stripe');
const { query }     = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { handleCors }  = require('../lib/cors');
const { ok, badRequest, forbidden, notFound, serverError, wrap } = require('../lib/respond');

module.exports = wrap(async (req, res) => {
  if (handleCors(req, res)) return;

  const user = requireAuth(req, res);
  if (!user) return;

  if (req.method === 'GET')  return listTrips(req, res, user);
  if (req.method === 'POST') return handlePost(req, res, user);

  return res.status(405).json({ message: 'Method not allowed.' });
});

// ── List ──────────────────────────────────────────────────────────────────────
async function listTrips(req, res, user) {
  const status = req.query?.status;
  const whereStatus = status ? `AND b.status = '${status.replace(/[^a-z]/g,'')}' ` : "";

  let rows;
  try {
    ({ rows } = await query(
      `SELECT
         b.id,
         b.booking_ref     AS "bookingRef",
         b.status,
         b.total_paid      AS total,
         b.cabin,
         b.seats,
         b.addons,
         b.created_at      AS "bookedAt",
         f.origin_code     AS origin,
         f.dest_code       AS destination,
         f.airline_code    AS airline,
         f.flight_number   AS "flightNumber",
         f.dep_time        AS departure,
         f.arr_time        AS arrival,
         f.dep_date        AS date
       FROM bookings b
       JOIN flights f ON f.id = b.flight_id
       WHERE b.user_id = $1
         AND b.status != 'pending'
         ${whereStatus}
       ORDER BY b.created_at DESC
       LIMIT 50`,
      [user.id]
    ));
  } catch (err) {
    return serverError(res, err);
  }

  // Shape into the format the frontend expects
  const trips = rows.map(r => ({
    bookingRef:  r.bookingRef,
    status:      r.status,
    total:       parseFloat(r.total) || 0,
    cabin:       r.cabin || 'economy',
    date:        r.date,
    departure:   r.departure ? String(r.departure).slice(0,5) : '',
    arrival:     r.arrival   ? String(r.arrival).slice(0,5)   : '',
    origin:      { code: r.origin },
    destination: { code: r.destination },
    flight:      { airline: { name: r.airline }, number: r.flightNumber },
  }));

  return ok(res, trips);
}

// ── POST dispatcher ───────────────────────────────────────────────────────────
async function handlePost(req, res, user) {
  const { action, bookingRef, tripId } = req.body ?? {};

  // Support both bookingRef (new) and tripId (legacy)
  const ref = bookingRef || tripId;

  if (action === 'cancel')             return cancelTrip(req, res, user, ref);
  if (action === 'reschedule-intent')  return createRescheduleIntent(req, res, user);
  if (action === 'reschedule')         return rescheduleTrip(req, res, user);

  return badRequest(res, `Unknown action: "${action}"`);
}

// ── Cancel ────────────────────────────────────────────────────────────────────
async function cancelTrip(req, res, user, ref) {
  if (!ref) return badRequest(res, 'bookingRef is required.');

  let booking;
  try {
    const { rows } = await query(
      'SELECT * FROM bookings WHERE booking_ref = $1 OR id::text = $1',
      [String(ref)]
    );
    booking = rows[0];
  } catch (err) {
    return serverError(res, err);
  }

  if (!booking)                    return notFound(res,  'Booking not found.');
  if (booking.user_id !== user.id) return forbidden(res, 'You cannot cancel this booking.');
  if (booking.status === 'cancelled')
    return badRequest(res, 'This booking is already cancelled.');

  const depDate = new Date(booking.dep_date ?? booking.departure_date ?? Date.now() + 86400000);
  if (depDate < new Date())
    return badRequest(res, 'Cannot cancel a booking after the departure date.');

  try {
    await query(
      "UPDATE bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
      [booking.id]
    );
  } catch (err) {
    return serverError(res, err);
  }

  // Restore seat count (non-fatal)
  try {
    const seatCount = JSON.parse(booking.seats ?? '[]').length || 1;
    await query(
      'UPDATE flights SET seats_left = seats_left + $1 WHERE id = $2',
      [seatCount, booking.flight_id]
    );
  } catch (err) {
    console.error('[Trips] Seat restore error (non-fatal):', err.message);
  }

  // Refund credits if any were used (non-fatal)
  if (booking.credits_used > 0) {
    try {
      await query('UPDATE users SET credits = credits + $1 WHERE id = $2',
        [booking.credits_used, user.id]);
      await query(
        `INSERT INTO credit_transactions (user_id, description, amount, type, created_at)
         VALUES ($1, $2, $3, 'refund', NOW())`,
        [user.id, `Refund for cancelled booking ${booking.booking_ref}`, booking.credits_used]
      );
    } catch (err) {
      console.error('[Trips] Credit refund error (non-fatal):', err.message);
    }
  }

  console.log(`[Trips] Cancelled ${booking.booking_ref} for user ${user.id}`);
  return ok(res, { cancelled: true, bookingRef: booking.booking_ref });
}

// ── Reschedule — Step 1: create Stripe PaymentIntent ─────────────────────────
async function createRescheduleIntent(req, res, user) {
  const { bookingRef, newDate, amount, originalPrice, newPrice } = req.body ?? {};

  if (!bookingRef) return badRequest(res, 'bookingRef is required.');
  if (!newDate)    return badRequest(res, 'newDate is required.');
  if (!amount || amount <= 0) return badRequest(res, 'amount must be a positive number.');

  // Verify the booking belongs to this user
  let booking;
  try {
    const { rows } = await query(
      'SELECT * FROM bookings WHERE booking_ref = $1 AND user_id = $2',
      [bookingRef, user.id]
    );
    booking = rows[0];
  } catch (err) {
    return serverError(res, err);
  }

  if (!booking) return notFound(res, 'Booking not found.');
  if (booking.status === 'cancelled') return badRequest(res, 'Cannot reschedule a cancelled booking.');
  if (booking.status === 'rescheduled') return badRequest(res, 'This booking has already been rescheduled once.');

  // Check departure is still in the future (must be > 48h per policy)
  const depDate = new Date(booking.dep_date ?? booking.departure_date ?? Date.now());
  const hoursUntilDep = (depDate - Date.now()) / 3600000;
  if (hoursUntilDep < 48)
    return badRequest(res, 'Rescheduling must be done at least 48 hours before departure.');

  // Check new date is in the future
  if (new Date(newDate) <= new Date())
    return badRequest(res, 'New date must be in the future.');

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return serverError(res, new Error('Stripe not configured'));

  const stripe = Stripe(stripeKey);

  let paymentIntent;
  try {
    // Get user email for receipt
    const { rows: uRows } = await query('SELECT email FROM users WHERE id = $1', [user.id]);
    const email = uRows[0]?.email || '';

    paymentIntent = await stripe.paymentIntents.create({
      amount:   Math.round(Number(amount)), // already in cents from frontend
      currency: (booking.currency || 'usd').toLowerCase(),
      metadata: {
        type:          'reschedule',
        bookingRef:    bookingRef,
        newDate:       newDate,
        userId:        String(user.id),
        originalPrice: String(originalPrice || 0),
        newPrice:      String(newPrice || 0),
      },
      description:   `FLYYB reschedule fee — ${bookingRef} → ${newDate}`,
      receipt_email: email || undefined,
    });
  } catch (err) {
    console.error('[Trips] Stripe intent error:', err.message);
    return serverError(res, err);
  }

  console.log(`[Trips] Reschedule intent ${paymentIntent.id} for ${bookingRef}`);
  return ok(res, {
    clientSecret: paymentIntent.client_secret,
    intentId:     paymentIntent.id,
    amount:       paymentIntent.amount,
  });
}

// ── Reschedule — Step 2: confirm after payment ────────────────────────────────
async function rescheduleTrip(req, res, user) {
  const { bookingRef, newDate, paymentIntentId } = req.body ?? {};

  if (!bookingRef)       return badRequest(res, 'bookingRef is required.');
  if (!newDate)          return badRequest(res, 'newDate is required.');
  if (!paymentIntentId)  return badRequest(res, 'paymentIntentId is required.');

  // Verify payment succeeded on Stripe
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return serverError(res, new Error('Stripe not configured'));

  const stripe = Stripe(stripeKey);
  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch (err) {
    return serverError(res, err);
  }

  if (intent.status !== 'succeeded')
    return badRequest(res, `Payment not confirmed (status: ${intent.status}). Please complete payment first.`);

  // Double-check the intent was for this booking
  if (intent.metadata?.bookingRef !== bookingRef)
    return forbidden(res, 'Payment intent does not match this booking.');

  // Fetch the booking
  let booking;
  try {
    const { rows } = await query(
      'SELECT * FROM bookings WHERE booking_ref = $1 AND user_id = $2',
      [bookingRef, user.id]
    );
    booking = rows[0];
  } catch (err) {
    return serverError(res, err);
  }

  if (!booking) return notFound(res, 'Booking not found.');
  if (booking.status === 'cancelled')    return badRequest(res, 'Cannot reschedule a cancelled booking.');
  if (booking.status === 'rescheduled')  return badRequest(res, 'Booking already rescheduled.');

  // Apply the reschedule
  try {
    await query(
      `UPDATE bookings
       SET status       = 'rescheduled',
           dep_date     = $1,
           reschedule_payment_intent = $2,
           updated_at   = NOW()
       WHERE id = $3`,
      [newDate, paymentIntentId, booking.id]
    );
  } catch (err) {
    return serverError(res, err);
  }

  // Log reschedule fee as a transaction (non-fatal)
  try {
    const feeAmount = intent.amount / 100;
    await query(
      `INSERT INTO credit_transactions (user_id, description, amount, type, created_at)
       VALUES ($1, $2, $3, 'reschedule_fee', NOW())`,
      [user.id, `Reschedule fee for ${bookingRef} → ${newDate}`, -feeAmount]
    );
  } catch (err) {
    console.error('[Trips] Transaction log error (non-fatal):', err.message);
  }

  console.log(`[Trips] Rescheduled ${bookingRef} to ${newDate} (intent: ${paymentIntentId})`);
  return ok(res, {
    rescheduled:  true,
    bookingRef:   bookingRef,
    newDate:      newDate,
  });
}
