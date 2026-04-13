/**

- FLYYB API — lib/auth.js
- 
- JWT verification helper shared by all api/*.js route files.
- 
- Environment variables required (set in Vercel project settings):
- JWT_SECRET   →  a long random string, e.g. openssl rand -hex 64
  */

const jwt = require('jsonwebtoken');

const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_EXPIRES = '30m';

if (!JWT_SECRET) {
console.error('[Auth] FATAL: JWT_SECRET environment variable is not set');
}

/**

- Sign a new JWT for the given user payload.
- 
- @param  {{ id: string, email: string }} payload
- @returns {string} signed JWT
  */
  function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  }

/**

- Verify a JWT and return the decoded payload.
- Throws if the token is invalid or expired.
- 
- @param  {string} token
- @returns {{ id: string, email: string, iat: number, exp: number }}
  */
  function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
  }

/**

- Express-style middleware that reads the Bearer token from the
- Authorization header, verifies it, and attaches the decoded payload
- to req.user.
- 
- Usage in any api/*.js handler:
- 
- const { requireAuth } = require('../lib/auth');
- 
- module.exports = async (req, res) => {
- const user = requireAuth(req, res);
  
- if (!user) return;            // requireAuth already sent 401
  
- // ... rest of handler
  
- };
- 
- @param {import('http').IncomingMessage} req
- @param {import('http').ServerResponse}  res
- @returns {object|null}  decoded user payload, or null if unauthorised
  */
  function requireAuth(req, res) {
  const header = req.headers['authorization'] ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

if (!token) {
res.status(401).json({ message: 'Authentication required.' });
return null;
}

try {
return verifyToken(token);
} catch (err) {
res.status(401).json({ message: 'Session expired. Please log in again.' });
return null;
}
}

module.exports = { signToken, verifyToken, requireAuth };