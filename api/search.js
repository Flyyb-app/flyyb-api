/**
 * FLYYB API — api/search.js
 *
 * GET /api/search?action=airports&q=lon&limit=8
 * GET /api/search?action=flights&from=JFK&to=LAX&date=2026-05-01&adults=1&cabin=economy&sort=price&currency=USD
 *
 * Public endpoint — no auth required.
 * Env var: DATABASE_URL
 */
const { query }      = require('../lib/db');
const { handleCors } = require('../lib/cors');
const { ok, badRequest, serverError, wrap } = require('../lib/respond');

module.exports = wrap(async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed.' });

  const action = req.query && req.query.action || '';
  if (action === 'airports') return searchAirports(req, res);
  if (action === 'flights')  return searchFlights(req, res);

  return badRequest(res, 'action must be "airports" or "flights".');
});

// ── Airport autocomplete ──────────────────────────────────────────────────────
async function searchAirports(req, res) {
  const q     = String(req.query && req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query && req.query.limit) || 8, 20);
  if (q.length < 1) return ok(res, []);

  let rows;
  try {
    const result = await query(
      'SELECT iata_code AS code,name,city,country FROM airports WHERE iata_code ILIKE $1 OR city ILIKE $1 OR name ILIKE $1 ORDER BY CASE WHEN iata_code ILIKE $2 THEN 0 WHEN city ILIKE $2 THEN 1 ELSE 2 END,city LIMIT $3',
      ['%' + q + '%', q + '%', limit]
    );
    rows = result.rows;
  } catch (err) { return serverError(res, err); }

  return ok(res, rows);
}

// ── Flight search ─────────────────────────────────────────────────────────────
async function searchFlights(req, res) {
  const q       = req.query || {};
  const from    = String(q.from  || '').toUpperCase();
  const to      = String(q.to    || '').toUpperCase();
  const date    = String(q.date  || '');
  const adults  = Math.max(1, parseInt(q.adults) || 1);
  const cabin   = String(q.cabin || 'economy').toLowerCase();
  const sort    = String(q.sort  || 'price');
  const currency = String(q.currency || 'USD');

  if (!from || !to || !date) return badRequest(res, 'from, to and date are required.');
  if (from === to) return badRequest(res, 'Origin and destination cannot be the same.');

  const CABIN_MULT = { economy: 1, premium: 1.6, premium_economy: 1.6, business: 3.2, first: 5.5 };
  const mult      = CABIN_MULT[cabin] || 1;
  const depDate   = new Date(date);
  const today     = new Date(); today.setHours(0, 0, 0, 0);
  const advDays   = Math.max(0, Math.floor((depDate - today) / 86400000));
  const dow       = depDate.getDay() === 0 ? 7 : depDate.getDay();

  let rows;
  try {
    const result = await query(
      'SELECT fs.flight_number,fs.airline_code,al.name AS airline_name,fs.origin_code,oa.city AS origin_city,fs.dest_code,da.city AS dest_city,fs.dep_time,fs.arr_time,fs.duration_min,fs.aircraft_type,fs.total_seats,r.base_price_usd FROM flight_schedules fs JOIN airlines al ON al.iata_code=fs.airline_code JOIN airports oa ON oa.iata_code=fs.origin_code JOIN airports da ON da.iata_code=fs.dest_code JOIN routes r ON r.origin_code=fs.origin_code AND r.dest_code=fs.dest_code AND r.airline_code=fs.airline_code WHERE fs.origin_code=$1 AND fs.dest_code=$2 AND $3=ANY(fs.days_of_week) AND $4=ANY(fs.cabin_classes) ORDER BY fs.dep_time LIMIT 10',
      [from, to, dow, cabin]
    );
    rows = result.rows;
  } catch (err) { return serverError(res, err); }

  // Currency conversion
  let rates = {};
  if (currency !== 'USD') {
    try {
      const cr = await query('SELECT code,rate_usd,symbol FROM currencies');
      cr.rows.forEach(function(c) { rates[c.code] = { rate: parseFloat(c.rate_usd), symbol: c.symbol }; });
    } catch (e) {}
  }

  const results = rows.map(function(f, i) {
    const baseUSD   = parseFloat(f.base_price_usd) * mult;
    const demandMul = advDays >= 60 ? 0.8 : advDays >= 30 ? 0.9 : advDays >= 7 ? 1.1 : 1.3;
    const usdPrice  = Math.round(baseUSD * demandMul * (0.95 + Math.random() * 0.1));
    let sym = '$', amount = usdPrice, curr = 'USD';
    if (currency !== 'USD' && rates[currency]) {
      sym    = rates[currency].symbol || currency;
      amount = Math.round(usdPrice * rates[currency].rate);
      curr   = currency;
    }
    return {
      flightNumber: f.flight_number,
      airline:      { code: f.airline_code, name: f.airline_name },
      origin:       { code: f.origin_code,  city: f.origin_city  },
      destination:  { code: f.dest_code,    city: f.dest_city    },
      departure:    f.dep_time ? String(f.dep_time).slice(0, 5) : '',
      arrival:      f.arr_time ? String(f.arr_time).slice(0, 5) : '',
      durationMin:  f.duration_min,
      duration:     Math.floor(f.duration_min / 60) + 'h ' + (f.duration_min % 60) + 'm',
      cabin:        cabin,
      stops:        0,
      via:          null,
      price:        { perPerson: amount, symbol: sym, currency: curr },
      seats:        { available: Math.max(1, Math.floor(f.total_seats * (advDays > 30 ? 0.7 : 0.3))), alert: null },
      aircraft:     f.aircraft_type,
      bestValue:    i === 0,
    };
  });

  // Sort
  if (sort === 'duration') results.sort(function(a, b) { return a.durationMin - b.durationMin; });
  else if (sort === 'dep') results.sort(function(a, b) { return a.departure.localeCompare(b.departure); });
  else results.sort(function(a, b) { return a.price.perPerson - b.price.perPerson; });

  console.log('[Search] ' + from + '->' + to + ' ' + date + ' pax=' + adults + ' cabin=' + cabin + ' -> ' + results.length + ' results');
  return ok(res, { results: results, from: from, to: to, date: date });
}
