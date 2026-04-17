/**
 * FLYYB API — lib/cors.js
 *
 * Handles OPTIONS preflight and sets CORS headers on every response.
 * Import at the top of every api/*.js route file.
 *
 * The allowed origin must match the frontend deployment URL exactly.
 * Update ALLOWED_ORIGIN if your frontend domain changes.
 */

const ALLOWED_ORIGIN = 'https://flyyb.vercel.app';

/**
 * Call this at the very start of every Vercel serverless handler.
 * Returns true if the request was a preflight (OPTIONS) and has been
 * handled — in that case, return immediately without further processing.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse}  res
 * @returns {boolean}  true = was OPTIONS preflight (caller should return)
 *
 * @example
 *   const { handleCors } = require('../lib/cors');
 *
 *   module.exports = async (req, res) => {
 *     if (handleCors(req, res)) return;
 *     // ... rest of handler
 *   };
 */
function handleCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;   // preflight handled
  }

  return false;    // caller should continue processing
}

module.exports = { handleCors };
