/**
 * FLYYB API — lib/respond.js
 *
 * Thin response helpers so every api/*.js route sends consistent
 * JSON shapes and status codes. All errors are also logged.
 */

/**
 * Send a 200 JSON success response.
 * @param {import('http').ServerResponse} res
 * @param {object} data
 */
function ok(res, data) {
  res.status(200).json(data);
}

/**
 * Send a 4xx/5xx JSON error response and log it.
 * @param {import('http').ServerResponse} res
 * @param {number} status  HTTP status code
 * @param {string} message Human-readable error message
 * @param {Error}  [err]   Optional original error for server-side logging
 */
function fail(res, status, message, err = null) {
  if (err) {
    console.error(`[API] ${status} — ${message}`, err.message);
  }
  res.status(status).json({ message });
}

/**
 * Convenience wrappers for common statuses.
 */
const badRequest   = (res, msg, err) => fail(res, 400, msg, err);
const unauthorised = (res, msg = 'Authentication required.')   => fail(res, 401, msg);
const forbidden    = (res, msg = 'You do not have permission.') => fail(res, 403, msg);
const notFound     = (res, msg = 'Resource not found.')        => fail(res, 404, msg);
const serverError  = (res, err, msg = 'An internal error occurred.') => fail(res, 500, msg, err);

/**
 * Wrap an entire route handler in try/catch so unhandled errors
 * always return a 500 instead of crashing the function.
 *
 * @param {Function} handler  async (req, res) => void
 * @returns {Function}        wrapped handler
 *
 * @example
 *   const { wrap } = require('../lib/respond');
 *   module.exports = wrap(async (req, res) => {
 *     // ... your handler code
 *   });
 */
function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error('[API] Unhandled error:', err.message, err.stack);
      res.status(500).json({ message: 'An unexpected error occurred.' });
    }
  };
}

module.exports = { ok, fail, badRequest, unauthorised, forbidden, notFound, serverError, wrap };
