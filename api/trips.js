/**

- FLYYB API — api/trips.js
- 
- GET  /api/trips                          → list user's bookings
- POST /api/trips  { action: 'cancel', tripId }  → cancel a booking
- 
- Requires: Authorization: Bearer <token>
  */

const { query }      = require('../lib/db');
const { requireAuth }   = require('../lib/auth');
const { handleCors }    = require('../lib/cors');
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
let rows;
try {
({ rows } = await query(
'SELECT b.id, b.booking_ref   AS "bookingRef", b.status, b.total_paid    AS "totalPaid", b.seats, b.addons, b.created_at    AS "bookedAt", f.origin, f.dest, f.airline, f.flight_number AS "flightNumber", f.dep_time      AS "depTime", f.dep_date      AS "departureDate" FROM bookings b JOIN flights  f ON f.id = b.flight_id WHERE b.user_id = $1 AND b.status != 'pending' ORDER BY b.created_at DESC LIMIT 50',
[user.id]
));
} catch (err) {
return serverError(res, err);
}

return ok(res, { trips: rows });
}

// ── POST dispatcher ───────────────────────────────────────────────────────────
async function handlePost(req, res, user) {
const { action, tripId } = req.body ?? {};
if (action === 'cancel') return cancelTrip(req, res, user, tripId);
return badRequest(res, 'Unknown action: "${action}"');
}

// ── Cancel ────────────────────────────────────────────────────────────────────
async function cancelTrip(req, res, user, tripId) {
if (!tripId) return badRequest(res, 'tripId is required.');

// Fetch the booking — verify it belongs to this user
let booking;
try {
const { rows } = await query(
'SELECT * FROM bookings WHERE id = $1',
[tripId]
);
booking = rows[0];
} catch (err) {
return serverError(res, err);
}

if (!booking)                     return notFound(res,   'Booking not found.');
if (booking.user_id !== user.id)  return forbidden(res,  'You cannot cancel this booking.');
if (booking.status === 'cancelled')
return badRequest(res, 'This booking is already cancelled.');

// Check the flight hasn't departed yet
const depDate = new Date(booking.departure_date ?? Date.now() + 86400000);
if (depDate < new Date())
return badRequest(res, 'Cannot cancel a booking after the departure date.');

// Mark as cancelled
try {
await query(
"UPDATE bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
[tripId]
);
} catch (err) {
return serverError(res, err);
}

// Restore seat count
try {
const seatCount = JSON.parse(booking.seats ?? '[]').length || 1;
await query(
'UPDATE flights SET seats_left = seats_left + $1 WHERE id = $2',
[seatCount, booking.flight_id]
);
} catch (err) {
// Non-fatal — log and continue
console.error('[Trips] Seat restore error (non-fatal):', err.message);
}

// Refund credits if any were used
if (booking.credits_used > 0) {
try {
await query(
'UPDATE users SET credits = credits + $1 WHERE id = $2',
[booking.credits_used, user.id]
);
await query(
'INSERT INTO credit_transactions (user_id, description, amount, type, created_at) VALUES ($1, $2, $3, 'refund', NOW())',
[user.id, 'Refund for cancelled booking ${booking.booking_ref}', booking.credits_used]
);
} catch (err) {
console.error('[Trips] Credit refund error (non-fatal):', err.message);
}
}

console.log('[Trips] Cancelled booking ${booking.booking_ref} for user ${user.id}');
return ok(res, { cancelled: true, bookingRef: booking.booking_ref });
}