/**

- FLYYB API — api/config.js
- 
- GET /api/config
- 
- Returns public-safe configuration values to the frontend.
- Currently exposes the Stripe PUBLISHABLE key (pk_live_…) only.
- 
- WHY this approach:
- The Stripe publishable key is safe to expose publicly — it can only
- be used to collect card data, not charge cards. However, hardcoding
- it in the frontend repo (index.html or a JS file) means it lives in
- git history forever. Serving it from an API endpoint means:
- • It never touches the git repo
  
- • You can rotate it in Vercel env vars with zero code changes
  
- • It works identically for test (pk_test_…) and live (pk_live_…)
  
- environments based on which Vercel environment is active
  
- 
- Environment variable required (set in Vercel project settings):
- STRIPE_PUBLISHABLE_KEY  →  pk_live_xxxx   (production) →  pk_test_xxxx   (preview / development)
  
- 
- NEVER put the secret key (sk_live_…) here — that lives only in
- STRIPE_SECRET_KEY and is used server-side in api/booking.js only.
- 
- No auth required — this endpoint is intentionally public.
  */

const { handleCors } = require('../lib/cors');
const { ok, serverError, wrap } = require('../lib/respond');

module.exports = wrap(async (req, res) => {
if (handleCors(req, res)) return;

if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed.' });

const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY;

if (!stripePublishableKey) {
console.error('[Config] STRIPE_PUBLISHABLE_KEY environment variable is not set');
return serverError(res, new Error('Missing env var'), 'Payment configuration unavailable.');
}

// Only expose the publishable key — never the secret key
return ok(res, {
stripePublishableKey,
environment: process.env.VERCEL_ENV ?? 'development',
});
});