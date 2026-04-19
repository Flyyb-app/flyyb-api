/**
 * FLYYB API — api/search.js
 *
 * GET /api/search?action=airports&q=LON&limit=8
 * GET /api/search?action=flights&from=JFK&to=LAX&date=2026-05-01&adults=1&cabin=economy&sort=price&currency=USD
 *
 * Public — no auth required.
 */

var { pool }       = require('../lib/db');
var { handleCors } = require('../lib/cors');

var CABIN_MULT = { economy: 1, premium_economy: 1.6, business: 3.2, first: 5.5 };

module.exports = async function(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var action = (req.query && req.query.action) || '';

  try {
    if (action === 'airports') return await searchAirports(req, res);
    if (action === 'flights')  return await searchFlights(req, res);
    return res.status(400).json({ error: 'action must be "airports" or "flights"' });
  } catch (err) {
    console.error('[Search]', err);
    res.status(500).json({ error: 'Search failed' });
  }
};

async function searchAirports(req, res) {
  var q     = String((req.query && req.query.q) || '').trim();
  var limit = Math.min(parseInt((req.query && req.query.limit) || '8'), 20);
  if (q.length < 1) return res.json([]);

  var client;
  try {
    client = await pool.connect();
    var r = await client.query(
      'SELECT iata_code AS code, name, city, country FROM airports ' +
      'WHERE iata_code ILIKE $1 OR city ILIKE $1 OR name ILIKE $1 ' +
      'ORDER BY CASE WHEN iata_code ILIKE $2 THEN 0 WHEN city ILIKE $2 THEN 1 ELSE 2 END, city ' +
      'LIMIT $3',
      ['%' + q + '%', q + '%', limit]
    );
    res.json(r.rows);
  } finally {
    if (client) client.release();
  }
}

async function searchFlights(req, res) {
  var q        = req.query || {};
  var from     = String(q.from  || '').toUpperCase();
  var to       = String(q.to    || '').toUpperCase();
  var date     = String(q.date  || '');
  var adults   = Math.max(1, parseInt(q.adults) || 1);
  var cabin    = String(q.cabin || 'economy').toLowerCase();
  var sort     = String(q.sort  || 'price');
  var currency = String(q.currency || 'USD');

  if (!from || !to || !date) return res.status(400).json({ error: 'from, to and date are required' });
  if (from === to) return res.status(400).json({ error: 'Origin and destination cannot be the same' });

  var mult    = CABIN_MULT[cabin] || 1;
  var depDate = new Date(date);
  var today   = new Date(); today.setHours(0,0,0,0);
  var advDays = Math.max(0, Math.floor((depDate - today) / 86400000));
  var dow     = depDate.getDay() === 0 ? 7 : depDate.getDay();

  var client;
  try {
    client = await pool.connect();

    var r = await client.query(
      'SELECT fs.flight_number, fs.airline_code, al.name AS airline_name, ' +
      'fs.origin_code, oa.city AS origin_city, fs.dest_code, da.city AS dest_city, ' +
      'fs.dep_time, fs.arr_time, fs.duration_min, fs.aircraft_type, fs.total_seats, r.base_price_usd ' +
      'FROM flight_schedules fs ' +
      'JOIN airlines al ON al.iata_code = fs.airline_code ' +
      'JOIN airports oa ON oa.iata_code = fs.origin_code ' +
      'JOIN airports da ON da.iata_code = fs.dest_code ' +
      'JOIN routes r ON r.origin_code = fs.origin_code AND r.dest_code = fs.dest_code AND r.airline_code = fs.airline_code ' +
      'WHERE fs.origin_code = $1 AND fs.dest_code = $2 AND $3 = ANY(fs.days_of_week) AND $4 = ANY(fs.cabin_classes) ' +
      'ORDER BY fs.dep_time LIMIT 10',
      [from, to, dow, cabin]
    );

    // Currency conversion
    var rates = {};
    if (currency !== 'USD') {
      try {
        var cr = await client.query('SELECT code, rate_usd, symbol FROM currencies');
        cr.rows.forEach(function(c) { rates[c.code] = { rate: parseFloat(c.rate_usd), symbol: c.symbol }; });
      } catch (e) {}
    }

    var demandMul = advDays >= 60 ? 0.8 : advDays >= 30 ? 0.9 : advDays >= 7 ? 1.1 : 1.3;

    var results = r.rows.map(function(f, i) {
      var usdPrice = Math.round(parseFloat(f.base_price_usd) * mult * demandMul * (0.95 + Math.random() * 0.1));
      var sym = '$', amount = usdPrice, curr = 'USD';
      if (currency !== 'USD' && rates[currency]) {
        amount = Math.round(usdPrice * rates[currency].rate);
        sym    = rates[currency].symbol || currency;
        curr   = currency;
      }
      return {
        flightNumber: f.flight_number,
        airline:      { code: f.airline_code, name: f.airline_name },
        origin:       { code: f.origin_code,  city: f.origin_city  },
        destination:  { code: f.dest_code,    city: f.dest_city    },
        departure:    f.dep_time ? String(f.dep_time).slice(0,5) : '',
        arrival:      f.arr_time ? String(f.arr_time).slice(0,5)  : '',
        durationMin:  f.duration_min,
        duration:     Math.floor(f.duration_min/60) + 'h ' + (f.duration_min%60) + 'm',
        cabin:        cabin,
        stops:        0,
        via:          null,
        price:        { perPerson: amount, symbol: sym, currency: curr },
        seats:        { available: Math.max(1, Math.floor(f.total_seats * (advDays > 30 ? 0.7 : 0.3))), alert: null },
        aircraft:     f.aircraft_type,
        bestValue:    i === 0,
      };
    });

    if (sort === 'duration') results.sort(function(a,b){ return a.durationMin - b.durationMin; });
    else if (sort === 'dep') results.sort(function(a,b){ return a.departure.localeCompare(b.departure); });
    else results.sort(function(a,b){ return a.price.perPerson - b.price.perPerson; });

    res.json({ results: results, from: from, to: to, date: date });
  } finally {
    if (client) client.release();
  }
}
