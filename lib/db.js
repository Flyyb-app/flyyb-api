/**

- FLYYB API — lib/db.js
- 
- Shared PostgreSQL connection pool.
- All api/*.js files import this — never create separate Pool instances.
- 
- Environment variable required (set in Vercel project settings):
- DATABASE_URL  →  postgres://user:pass@host:5432/dbname
  */

const { Pool } = require('pg');

// Vercel serverless functions are stateless, but the Pool is module-cached
// within the same function instance, reducing connection overhead.
const pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: { rejectUnauthorized: false },   // required for most managed Postgres hosts
max: 5,                               // keep small — Vercel functions are ephemeral
idleTimeoutMillis: 10_000,
connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
// Log but don't crash — the next query will reconnect
console.error('[DB] Unexpected pool error:', err.message);
});

/**

- Run a parameterised query against the pool.
- 
- @param {string}  text    SQL string with $1, $2 … placeholders
- @param {Array}   params  Values for the placeholders
- @returns {Promise<import('pg').QueryResult>}
- 
- @example
- const { rows } = await query(
- 'SELECT * FROM users WHERE email = $1',
  
- [email]
  
- );
  */
  async function query(text, params = []) {
  const start = Date.now();
  try {
  const result = await pool.query(text, params);
  const ms     = Date.now() - start;
  if (process.env.NODE_ENV !== 'production') {
  console.log('[DB] ${ms}ms — ${text.slice(0, 80)}');
  }
  return result;
  } catch (err) {
  console.error('[DB] Query error:', err.message, '| SQL:', text.slice(0, 120));
  throw err;
  }
  }

module.exports = { query, pool };