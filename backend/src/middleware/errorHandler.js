// src/middleware/errorHandler.js
// ─────────────────────────────────────────────────────────────
//  Global Express error handler — catches everything thrown by
//  routes and services, logs it, and returns clean JSON.
//
//  Always the LAST middleware registered in index.js.
// ─────────────────────────────────────────────────────────────

const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

function errorHandler(err, req, res, next) {  // eslint-disable-line no-unused-vars
  // ── Determine error shape ───────────────────────────────────
  const isOperational = err instanceof AppError && err.isOperational;
  const status  = err.statusCode || 500;
  const code    = err.code       || 'INTERNAL_ERROR';
  const message = isOperational  ? err.message : 'An unexpected error occurred.';

  // ── Log it ──────────────────────────────────────────────────
  if (status >= 500) {
    logger.error('Unhandled server error', {
      code,
      message:    err.message,
      stack:      err.stack,
      path:       req.path,
      method:     req.method,
      userId:     req.user?.id || null,
      ip:         req.ip,
    });
  } else {
    logger.warn('Client error', {
      code,
      message:    err.message,
      path:       req.path,
      method:     req.method,
      userId:     req.user?.id || null,
      status,
    });
  }

  // ── Send response ────────────────────────────────────────────
  const body = {
    success: false,
    error: {
      code,
      message,
      // Only include debug details in non-production environments
      ...(process.env.NODE_ENV !== 'production' && err.details
        ? { details: err.details }
        : {}),
      ...(process.env.NODE_ENV !== 'production' && !isOperational
        ? { stack: err.stack }
        : {}),
    },
  };

  res.status(status).json(body);
}

module.exports = errorHandler;