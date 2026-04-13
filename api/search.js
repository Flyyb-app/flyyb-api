/**

- FLYYB API — api/search.js
- 
- GET /api/search?type=airports&q=lon   → airport autocomplete
- GET /api/search?type=flights&origin=JFK&dest=LAX&date=2026-05-01&adults=1&cabin=economy → flight results
- 
- Public endpoint — no auth required.
  */

const { query }      = require('../lib/db');
const { handleCors } = require('../lib/cors');
const { ok, badRequest, serverError, wrap } = require('../lib/respond');

module.exports = wrap(async (req, res) => {
if (handleCors(req, res)) return;

if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed.' });

const { type } = req.query ?? {};

if (type === 'airports') return searchAirports(req, res);
if (type === 'flights')  return searchFlights(req, res);

return badRequest(res, 'type must be "airports" or "flights".');
});

// ── Airport autocomplete ──────────────────────────────────────────────────────
async function searchAirports(req, res) {
const q = (req.query.q ?? '').trim();
if (q.length < 2) return ok(res, { airports: [] });

let rows;
try {
({ rows } = await query(
'SELECT iata, name, city, country FROM airports WHERE iata    ILIKE $1 OR city    ILIKE $1 OR name    ILIKE $1 ORDER BY CASE WHEN iata ILIKE $2 THEN 0 ELSE 1 END, city LIMIT 8',
['%${q}%', '${q}%']
));
} catch (err) {
return serverError(res, err);
}

return ok(res, { airports: rows });
}

// ── Flight search ─────────────────────────────────────────────────────────────
async function searchFlights(req, res) {
const { origin, dest, date, retDate, adults = 1, cabin = 'economy' } = req.query ?? {};

if (!origin || !dest || !date)
return badRequest(res, 'origin, dest and date are required.');

if (origin === dest)
return badRequest(res, 'Origin and destination cannot be the same.');

let rows;
try {
({ rows } = await query(
'SELECT f.id, f.flight_number  AS "flightNumber", f.airline, f.airline_code   AS "airlineCode", f.origin, f.dest, f.dep_time       AS "depTime", f.arr_time       AS "arrTime", f.duration, f.stops, f.cabin, f.seats_left     AS "seatsLeft", ROUND(f.base_price * $4::numeric) AS price FROM flights f WHERE f.origin  = $1 AND f.dest    = $2 AND f.dep_date = $3 AND f.cabin   = $5 AND f.seats_left > 0 ORDER BY f.base_price ASC LIMIT 20',
[
origin.toUpperCase(),
dest.toUpperCase(),
date,
parseInt(adults, 10),
cabin.toLowerCase(),
]
));
} catch (err) {
return serverError(res, err);
}

// Mark lowest price as best value
const flights = rows.map((f, i) => ({ …f, price: Number(f.price), best: i === 0 }));

console.log('[Search] ${origin}→${dest} ${date} adults=${adults} cabin=${cabin} → ${flights.length} results');
return ok(res, { flights });
}