/**
 * FLYYB API — api/config.js
 * GET /api/config — returns Stripe publishable key to frontend
 * This endpoint is PUBLIC (no auth required).
 * The frontend calls this to get the pk_live_... key without it being in source code.
 */
var { handleCors } = require('../lib/cors');

module.exports = async function(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  var key = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!key) return res.status(500).json({ error: 'Stripe not configured' });
  res.json({ stripeKey: key, environment: process.env.VERCEL_ENV || 'development' });
};
