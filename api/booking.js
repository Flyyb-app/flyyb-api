/**

- FLYYB API — api/booking.js
- 
- POST /api/booking
- Body: { flightId, seats, addons, creditsApplied, totalCents }
- 
- Flow:
- 1. Validate request
- 1. Check seat availability
- 1. Apply credits if requested
- 1. Create a Stripe PaymentIntent
- 1. Insert a pending booking row
- 1. Return { clientSecret, bookingRef }
- 
- The frontend confirms the payment with Stripe directly.
- Use a Stripe webhook (api/webhook.js) to mark bookings as confirmed.
- 
- Requires: Authorization: Bearer <token>
- 
- Environment variables:
- STRIPE_SECRET_KEY  →  sk_live_xxx  (set in Vercel project settings)
  */

const stripe         = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { query }      = require('../lib/db');
const { requireAuth }   = require('../lib/auth');
const { handleCors }    = require('../lib/cors');
const { ok, badRequest, serverError, wrap } = require('../lib/respond');

module.exports = wrap(async (req, res) => {
if (handleCors(req, res)) return;

if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed.' });

const user = requireAuth(req, res);
if (!user) return;

const { flightId, seats = [], addons = [], creditsApplied = false, totalCents } = req.body ?? {};

// ── Validate ──────────────────────────────────────────────────────────────
if (!flightId)         return badRequest(res, 'flightId is required.');
if (!seats.length)     return badRequest(res, 'At least one seat must be selected.');
if (!totalCents || totalCents < 50)
return badRequest(res, 'Invalid total amount.');

// ── Fetch flight ──────────────────────────────────────────────────────────
let flight;
try {
const { rows } = await query('SELECT * FROM flights WHERE id = $1', [flightId]);
flight = rows[0];
} catch (err) {
return serverError(res, err);
}

if (!flight) return badRequest(res, 'Flight not found.');
if (flight.seats_left < seats.length)
return badRequest(res, 'Only ${flight.seats_left} seat(s) remaining on this flight.');

// ── Credits ───────────────────────────────────────────────────────────────
let creditDiscount = 0;
if (creditsApplied) {
try {
const { rows } = await query('SELECT credits FROM users WHERE id = $1', [user.id]);
creditDiscount = Math.min(rows[0]?.credits ?? 0, Math.floor(totalCents / 100));
} catch (err) {
return serverError(res, err);
}
}

const chargeAmount = Math.max(50, totalCents - creditDiscount * 100); // cents, min $0.50

// ── Stripe PaymentIntent ──────────────────────────────────────────────────
let intent;
try {
intent = await stripe.paymentIntents.create({
amount:   chargeAmount,
currency: 'usd',
metadata: { userId: user.id, flightId, seats: seats.join(',') },
});
} catch (err) {
console.error('[Booking] Stripe error:', err.message);
return serverError(res, err, 'Could not initialise payment. Please try again.');
}

// ── Generate booking reference ────────────────────────────────────────────
const bookingRef = 'FLY' + Math.random().toString(36).slice(2, 8).toUpperCase();

// ── Insert pending booking ────────────────────────────────────────────────
try {
await query(
'INSERT INTO bookings (id, user_id, flight_id, seats, addons, total_paid, credits_used, status, stripe_intent_id, booking_ref, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, NOW())',
[
intent.id,          // use Stripe intent ID as booking PK
user.id,
flightId,
JSON.stringify(seats),
JSON.stringify(addons),
chargeAmount / 100,
creditDiscount,
intent.id,
bookingRef,
]
);
} catch (err) {
// Don't fail the whole request — the webhook will handle confirmation
console.error('[Booking] DB insert error (non-fatal):', err.message);
}

console.log('[Booking] Created ${bookingRef} for user ${user.id} — $${chargeAmount / 100}');

return ok(res, {
clientSecret: intent.client_secret,
bookingRef,
});
});