// src/utils/errors.js
// ─────────────────────────────────────────────────────────────
//  Standardised error handling utilities.
//
//  AppError  — throw these from anywhere in the app; the global
//              error handler will format them into clean JSON.
//
//  asyncHandler — wraps async route handlers so you never need
//                 try/catch in every route. Any thrown error
//                 automatically goes to Express's error handler.
// ─────────────────────────────────────────────────────────────

/**
 * Custom application error.
 * @param {string}  message    - Human-readable error description
 * @param {number}  statusCode - HTTP status code (default 500)
 * @param {string}  code       - Machine-readable code for clients (e.g. "AGENT_NOT_FOUND")
 * @param {object}  details    - Optional extra info (never include sensitive data!)
 */
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.name       = 'AppError';
    this.statusCode = statusCode;
    this.code       = code;
    this.details    = details;
    this.isOperational = true; // operational errors are safe to surface to clients
    Error.captureStackTrace(this, this.constructor);
  }
}

// ── Common pre-built errors ───────────────────────────────────
const Errors = {
  notFound:      (msg = 'Resource not found')  => new AppError(msg, 404, 'NOT_FOUND'),
  unauthorized:  (msg = 'Unauthorized')         => new AppError(msg, 401, 'UNAUTHORIZED'),
  forbidden:     (msg = 'Forbidden')            => new AppError(msg, 403, 'FORBIDDEN'),
  badRequest:    (msg = 'Bad request')          => new AppError(msg, 400, 'BAD_REQUEST'),
  tooMany:       (msg = 'Too many requests')    => new AppError(msg, 429, 'RATE_LIMITED'),
  elevenlabs:    (msg, details)                 => new AppError(msg, 502, 'ELEVENLABS_ERROR', details),
  database:      (msg, details)                 => new AppError(msg, 500, 'DATABASE_ERROR', details),
};

/**
 * Wraps an async Express route handler and forwards any errors
 * to the next() error-handling middleware — no try/catch needed.
 *
 * Usage:
 *   router.get('/path', asyncHandler(async (req, res) => { ... }));
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { AppError, Errors, asyncHandler };