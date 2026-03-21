const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

const JWT_SECRET          = process.env.JWT_SECRET || 'change-this-secret';
const JWT_EXPIRES_IN      = '1h';
const REFRESH_EXPIRES_IN  = '30d';
const BCRYPT_ROUNDS       = 12;

// ── Password ─────────────────────────────────────────────────
async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// ── JWT Access Token ─────────────────────────────────────────
function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

// ── Refresh Token ─────────────────────────────────────────────
const crypto = require('crypto');

function generateRefreshToken() {
  return crypto.randomBytes(48).toString('hex');
}

async function hashToken(token) {
  return bcrypt.hash(token, 8);
}

// ── Middleware helper ─────────────────────────────────────────
function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function requireAuth(req, res) {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  try {
    return verifyAccessToken(token);
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }
}

// ── CORS ──────────────────────────────────────────────────────
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
  return false;
}

module.exports = {
  hashPassword, verifyPassword,
  signAccessToken, verifyAccessToken,
  generateRefreshToken, hashToken,
  extractToken, requireAuth,
  cors,
};
