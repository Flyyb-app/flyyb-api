var jwt    = require('jsonwebtoken');
var bcrypt = require('bcryptjs');
var crypto = require('crypto');

var JWT_SECRET     = process.env.JWT_SECRET;
var ACCESS_EXPIRES = '1h';
var ALLOWED_ORIGIN = 'https://flyyb.vercel.app';

if (!JWT_SECRET) console.error('[Auth] FATAL: JWT_SECRET not set');

// Sign access token — payload includes both sub and id for compatibility
function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, id: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: ACCESS_EXPIRES }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function generateRefreshToken() {
  return crypto.randomBytes(40).toString('hex');
}

async function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

// requireAuth — returns payload with both .sub and .id normalised
function requireAuth(req, res) {
  var header = req.headers['authorization'] || '';
  var token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'Authentication required' }); return null; }
  try {
    var p = verifyAccessToken(token);
    p.id  = p.id  || p.sub;
    p.sub = p.sub || p.id;
    return p;
  } catch (e) {
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
    return null;
  }
}

// cors() — called by all api files (including BAU auth.js which uses authLib.cors)
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

module.exports = { signAccessToken, verifyAccessToken, generateRefreshToken, hashToken, verifyPassword, hashPassword, requireAuth, cors };
