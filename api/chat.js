/**
 * FLYYB API — api/chat.js
 *
 * POST /api/chat
 * Body: { message, history, context }
 *
 * Uses Google Gemini (gemini-2.5-flash) via generativelanguage.googleapis.com.
 *
 * Environment variable required (set in Vercel project settings):
 *   GEMINI_API_KEY  →  your Google AI Studio API key
 *
 * All AIRA logic, system prompt, RAG, flight search, date parsing and
 * airport resolution are preserved exactly from the original.
 */

const { handleCors } = require('../lib/cors');
const knowledge      = require('./aira');

// ── AIRA system prompt (unchanged from original) ───────────────────────────
const AIRA_SYSTEM = [
  'You are AIRA (AI Reservations Assistant), FLYYBs premium AI flight concierge.',
  'You are warm, efficient and feel like a knowledgeable air hostess who knows the passenger personally.',
  'Speak in short clear sentences. Use the users first name naturally.',
  '',
  'FLIGHT SEARCH RULE - CRITICAL:',
  'When a user asks to search, find, book, or mentions any flight route (e.g. "fly to Dubai", "Singapore to Chennai", "book flight to London next Friday"), you MUST respond with ONLY this exact JSON on a single line - no other text, no markdown, no explanation:',
  '{"action":"search","from":"CITY_OR_CODE","to":"CITY_OR_CODE","date":"DATE_AS_SPOKEN","cabin":"economy"}',
  'If the user mentions a cabin class, use it (economy/business/first). If from/to is missing, use empty string "".',
  'Examples:',
  '- "fly to Dubai next week" -> {"action":"search","from":"","to":"Dubai","date":"next week","cabin":"economy"}',
  '- "Singapore to Chennai April 9" -> {"action":"search","from":"Singapore","to":"Chennai","date":"April 9","cabin":"economy"}',
  '- "book flight next sunday" -> {"action":"search","from":"","to":"","date":"next sunday","cabin":"economy"}',
  '- "business class London to NYC" -> {"action":"search","from":"London","to":"New York","date":"next week","cabin":"business"}',
  '',
  'BOOKING RULE - CRITICAL:',
  'NEVER confirm a booking or say a flight is booked. NEVER say things like "your flight is booked" or "booking confirmed".',
  'If a user says "book", "confirm", "proceed", "yes", "ok", "go ahead" - respond warmly and say you are opening the booking form for them.',
  'The actual booking happens in the app, not in chat.',
  '',
  'MISSING INFO RULE:',
  'If from/to is missing, ask the user: "Sure! Where are you flying from, and where to?"',
  '',
  'FLYYB POLICIES:',
  'Free cancellation up to 24h before departure. Rescheduling up to 48h before.',
  'Earn 5% credits on every booking. Credits pay up to 20% of any booking.',
  'Baggage: economy 23kg checked + 7kg cabin, business 32kg checked + 10kg cabin.',
  'Online check-in opens 24h before departure.',
  '',
  'For general questions, respond as a helpful, friendly travel concierge.',
  'Keep responses concise - max 3 sentences for general answers.',
].join('\n');

// ── Currency maps (unchanged from original) ────────────────────────────────
const COUNTRY_CURRENCY = {US:'USD',GB:'GBP',IN:'INR',AU:'AUD',CA:'CAD',SG:'SGD',AE:'AED',JP:'JPY',DE:'EUR',FR:'EUR',NZ:'NZD',MY:'MYR',TH:'THB',PH:'PHP',ID:'IDR',VN:'VND',KR:'KRW',CN:'CNY',HK:'HKD',TW:'TWD',PK:'PKR',BD:'BDT',LK:'LKR',NP:'NPR',QA:'QAR',SA:'SAR'};
const CURR_SYMBOLS     = {USD:'$',EUR:'€',GBP:'£',INR:'₹',JPY:'¥',AUD:'A$',CAD:'C$',SGD:'S$',AED:'AED',CHF:'CHF',CNY:'¥',HKD:'HK$',KRW:'₩',MYR:'RM',THB:'฿',IDR:'Rp',PHP:'₱',VND:'₫',TWD:'NT$',NZD:'NZ$',BRL:'R$',MXN:'MX$',ZAR:'R',TRY:'₺',SEK:'kr',NOK:'kr',DKK:'kr',PKR:'₨',BDT:'৳',LKR:'₨',NPR:'₨',QAR:'QAR',SAR:'SAR'};

// ── DB pool (unchanged from original) ─────────────────────────────────────
let _pool = null;
function getPool() {
  if (!_pool) {
    const pg = require('pg');
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  }
  return _pool;
}

// ── Exchange rate cache (unchanged from original) ──────────────────────────
let ratesCache = null, ratesCacheTime = 0;
async function getRates(client) {
  if (ratesCache && Date.now() - ratesCacheTime < 3600000) return ratesCache;
  try {
    const r = await client.query('SELECT code,rate_usd,symbol FROM currencies');
    ratesCache = {};
    r.rows.forEach(c => { ratesCache[c.code] = { rate: parseFloat(c.rate_usd), symbol: c.symbol }; });
    ratesCacheTime = Date.now();
    return ratesCache;
  } catch (e) {
    return { USD: { rate: 1, symbol: '$' } };
  }
}

function convertPrice(usd, currency, rates) {
  if (!currency || currency === 'USD') return { amount: usd, symbol: '$', code: 'USD' };
  const r = rates[currency];
  if (!r) return { amount: usd, symbol: '$', code: 'USD' };
  return { amount: Math.round(usd * r.rate), symbol: r.symbol || CURR_SYMBOLS[currency] || '$', code: currency };
}

// ── Flight search (unchanged from original) ────────────────────────────────
async function searchFlights(from, to, date, cabin, currency) {
  cabin = cabin || 'economy';
  let client;
  try {
    client = await getPool().connect();
    const rates       = await getRates(client);
    const depDate     = new Date(date);
    const today       = new Date(); today.setHours(0, 0, 0, 0);
    const advanceDays = Math.max(0, Math.floor((depDate - today) / 86400000));
    const dow         = depDate.getDay() === 0 ? 7 : depDate.getDay();

    if (!currency) {
      const apRes = await client.query('SELECT country FROM airports WHERE iata_code=$1', [from.toUpperCase()]);
      currency = apRes.rows.length ? (COUNTRY_CURRENCY[apRes.rows[0].country] || 'USD') : 'USD';
    }

    const dr = await client.query(
      'SELECT fs.flight_number,fs.airline_code,al.name AS airline_name,fs.origin_code,oa.city AS origin_city,fs.dest_code,da.city AS dest_city,fs.dep_time,fs.arr_time,fs.duration_min,fs.aircraft_type,fs.total_seats,r.base_price_usd FROM flight_schedules fs JOIN airlines al ON al.iata_code=fs.airline_code JOIN airports oa ON oa.iata_code=fs.origin_code JOIN airports da ON da.iata_code=fs.dest_code JOIN routes r ON r.origin_code=fs.origin_code AND r.dest_code=fs.dest_code AND r.airline_code=fs.airline_code WHERE fs.origin_code=$1 AND fs.dest_code=$2 AND $3=ANY(fs.days_of_week) AND $4=ANY(fs.cabin_classes) ORDER BY fs.dep_time LIMIT 6',
      [from.toUpperCase(), to.toUpperCase(), dow, cabin]
    );

    const CABIN_MULT = { economy: 1, premium_economy: 1.6, business: 3.2, first: 5.5 };
    const mult = CABIN_MULT[cabin] || 1;

    return dr.rows.map(f => {
      const usdPrice = Math.round(parseFloat(f.base_price_usd) * mult * (advanceDays >= 60 ? 0.8 : advanceDays >= 30 ? 0.9 : advanceDays >= 7 ? 1.1 : 1.3) * (0.95 + Math.random() * 0.1));
      const conv = convertPrice(usdPrice, currency, rates);
      return {
        flightNumber: f.flight_number,
        airline:      { code: f.airline_code, name: f.airline_name },
        origin:       { code: f.origin_code,  city: f.origin_city  },
        destination:  { code: f.dest_code,    city: f.dest_city    },
        departure:    f.dep_time ? f.dep_time.slice(0, 5) : '',
        arrival:      f.arr_time ? f.arr_time.slice(0, 5) : '',
        durationMin:  f.duration_min,
        duration:     Math.floor(f.duration_min / 60) + 'h ' + (f.duration_min % 60) + 'm',
        cabin, stops: 0, via: null,
        price:   { perPerson: conv.amount, symbol: conv.symbol, currency: conv.code },
        seats:   { available: Math.max(1, Math.floor(f.total_seats * (advanceDays > 30 ? 0.7 : 0.3))), alert: null },
        aircraft: f.aircraft_type,
      };
    });
  } catch (e) {
    console.error('AIRA search:', e.message);
    return [];
  } finally {
    if (client) client.release();
  }
}

// ── Natural date parser (unchanged from original) ──────────────────────────
function parseNaturalDate(text) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const t   = (text || '').toLowerCase().trim();
  if (!t || t === 'null' || t === 'undefined') return new Date(now.getTime() + 7 * 86400000).toISOString().split('T')[0];
  if (t === 'today') return now.toISOString().split('T')[0];
  if (t.includes('tomorrow')) { const d = new Date(now); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]; }

  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  for (let i = 0; i < days.length; i++) {
    if (t.includes('next ' + days[i]) || t.includes('this ' + days[i]) || t === days[i]) {
      const d = new Date(now);
      let diff = (i - d.getDay() + 7) % 7;
      if (diff === 0 || t.includes('next')) diff = diff || 7;
      d.setDate(d.getDate() + diff);
      return d.toISOString().split('T')[0];
    }
  }

  const dm = t.match(/in (\d+) days?/);  if (dm) { const d = new Date(now); d.setDate(d.getDate() + parseInt(dm[1]));     return d.toISOString().split('T')[0]; }
  const wm = t.match(/in (\d+) weeks?/); if (wm) { const d = new Date(now); d.setDate(d.getDate() + parseInt(wm[1]) * 7); return d.toISOString().split('T')[0]; }

  const months     = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monthShort = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  for (let i = 0; i < months.length; i++) {
    if (t.includes(months[i]) || t.includes(monthShort[i])) {
      const yearMatch = t.match(/(202\d)/);
      const dayMatch  = t.match(/(\d{1,2})(?:st|nd|rd|th)?/);
      const year      = yearMatch ? parseInt(yearMatch[1]) : now.getFullYear();
      if (dayMatch) {
        const day = parseInt(dayMatch[1]);
        const d   = new Date(year, i, day);
        if (d <= now && !yearMatch) d.setFullYear(d.getFullYear() + 1);
        return d.toISOString().split('T')[0];
      }
    }
  }

  const isoMatch = t.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[0];

  const d = new Date(now); d.setDate(d.getDate() + 7);
  return d.toISOString().split('T')[0];
}

// ── Airport resolver (unchanged from original) ─────────────────────────────
async function resolveAirport(city) {
  if (!city || city.trim() === '') return null;
  let client;
  try {
    client = await getPool().connect();
    const r = await client.query(
      'SELECT iata_code,city,name FROM airports WHERE lower(iata_code)=lower($1) OR lower(city) LIKE lower($2) OR lower(name) LIKE lower($2) ORDER BY is_major DESC LIMIT 1',
      [city.trim(), '%' + city.trim() + '%']
    );
    return r.rows[0] || null;
  } catch (e) {
    return null;
  } finally {
    if (client) client.release();
  }
}

// ── Main Gemini handler (unchanged from original) ──────────────────────────
async function handleAira(message, history, context, apiKey, res) {
  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;

    // Build conversation history for Gemini
    const contents = []; let lastRole = null;
    history.forEach(m => {
      const role = m.role === 'assistant' ? 'model' : 'user';
      if (role !== lastRole) { contents.push({ role, parts: [{ text: m.content || '' }] }); lastRole = role; }
    });
    while (contents.length && contents[0].role === 'model') contents.shift();
    if (contents.length && contents[contents.length - 1].role === 'user') contents.pop();

    // RAG: inject relevant knowledge for this query
    const ragContext = knowledge.getRelevantKnowledge(message);
    const ragStr     = ragContext.length ? ('\n\nRelevant FLYYB knowledge:\n' + ragContext.join('\n')) : '';
    const userMsg    = (context ? '[User context: ' + context + ']\n' : '') + (ragStr ? ragStr + '\n\n' : '') + message;
    contents.push({ role: 'user', parts: [{ text: userMsg }] });

    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        systemInstruction: { parts: [{ text: AIRA_SYSTEM }] },
        contents,
        generationConfig: { maxOutputTokens: 300, temperature: 0.6 },
      }),
    });

    const d = await r.json();
    if (d.error) { console.error('Gemini:', d.error.message); return res.status(500).json({ error: 'Chat unavailable' }); }

    let reply = d.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!reply) return res.json({ reply: "I'm not sure about that. Could you rephrase?" });
    reply = reply.trim();

    // Check if Gemini returned a search action JSON
    const actionMatch = reply.match(/\{"action"\s*:\s*"search"[^}]*\}/);
    if (actionMatch) {
      try {
        const intent = JSON.parse(actionMatch[0]);

        if (!intent.from && !intent.to) return res.json({ reply: "Sure! Where would you like to fly from, and where to?" });
        if (!intent.to)                 return res.json({ reply: "Got it! Where would you like to fly to?" });
        if (!intent.from)               return res.json({ reply: "Great destination! Where are you flying from?" });

        const fromAP = await resolveAirport(intent.from);
        const toAP   = await resolveAirport(intent.to);

        if (fromAP && toAP) {
          const dateStr   = intent.date ? parseNaturalDate(intent.date) : parseNaturalDate('next week');
          const cabin     = intent.cabin || 'economy';
          const currMatch = context.match(/Currency: ([A-Z]{3})/);
          const currency  = currMatch ? currMatch[1] : 'USD';
          const flights   = await searchFlights(fromAP.iata_code, toAP.iata_code, dateStr, cabin, currency);

          if (flights.length) {
            const dateDisp = new Date(dateStr).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
            return res.json({ action: 'show_flights', flights, from: fromAP.city, to: toAP.city, date: dateDisp, isoDate: dateStr, reply: 'Found ' + flights.length + ' flights!' });
          }
          return res.json({ reply: 'No flights found from ' + fromAP.city + ' to ' + toAP.city + ' on that date. Try different dates or cabin class?' });
        }
        if (!fromAP) return res.json({ reply: 'I couldn\'t find "' + intent.from + '" as an airport. Could you try the airport code e.g. SIN, DEL, DXB?' });
        if (!toAP)   return res.json({ reply: 'I couldn\'t find "' + intent.to   + '" as an airport. Could you try the airport code?' });
      } catch (e) {
        console.error('Intent parse:', e.message);
      }
    }

    // Block hallucinated booking confirmations from Gemini
    const lowerReply = reply.toLowerCase();
    if ((lowerReply.includes('booked') || lowerReply.includes('booking confirmed') ||
         (lowerReply.includes('confirmation') && lowerReply.includes('sent'))) &&
        !lowerReply.includes('?') && !lowerReply.includes('would you')) {
      return res.json({ reply: "I'll open the booking form for you now! Just tap 'Book Now' to proceed." });
    }

    return res.json({ reply });

  } catch (err) {
    console.error('AIRA error:', err.message);
    return res.status(500).json({ error: 'Chat unavailable' });
  }
}

// ── Route handler ──────────────────────────────────────────────────────────
module.exports = function (req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const b = req.body || {};
  if (!b.message) return res.status(400).json({ error: 'Message required' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Chat not configured' });

  handleAira(b.message, (b.history || []).slice(-12), b.context || '', apiKey, res);
};
