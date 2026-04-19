const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const JWT_SECRET     = process.env.JWT_SECRET;
const ACCESS_EXPIRES = '1h';

if (!JWT_SECRET) console.error('[Auth] FATAL: JWT_SECRET not set');

// Sign a short-lived access token
function signAccessToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: ACCESS_EXPIRES }
  );
}

// Verify an access token — throws if invalid or expired
function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// Generate a secure random refresh token string
function generateRefreshToken() {
  return crypto.randomBytes(40).toString('hex');
}

// SHA-256 hash a refresh token for safe DB storage
async function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Compare plaintext password against bcrypt hash
async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// Hash a plaintext password
async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

// Middleware helper — reads Bearer token, verifies, returns payload or sends 401
function requireAuth(req, res) {
  var header = req.headers['authorization'] || '';
  var token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  try {
    return verifyAccessToken(token);
  } catch (e) {
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
    return null;
  }
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashToken,
  verifyPassword,
  hashPassword,
  requireAuth,
};
