// src/utils/logger.js
// ─────────────────────────────────────────────────────────────
//  Centralised logging via Winston.
//  - In development: pretty-printed coloured console output
//  - In production:  structured JSON (easy to ship to Datadog,
//    Logtail, Papertrail, etc.)
//  Usage:
//    const logger = require('../utils/logger');
//    logger.info('Server started', { port: 3001 });
//    logger.error('DB error', { err: error.message, stack: error.stack });
// ─────────────────────────────────────────────────────────────

const winston = require('winston');

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

// Custom readable format for dev
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length
      ? '\n  ' + JSON.stringify(meta, null, 2).replace(/\n/g, '\n  ')
      : '';
    return `${timestamp} [${level}] ${stack || message}${metaStr}`;
  })
);

// Structured JSON format for production (each log is one JSON line)
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: process.env.NODE_ENV === 'production' ? prodFormat : devFormat,
  transports: [
    new winston.transports.Console(),
  ],
});

// In production, also write errors to a file so you can review them
if (process.env.NODE_ENV === 'production') {
  logger.add(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5 * 1024 * 1024, // 5 MB
      maxFiles: 5,
    })
  );
  logger.add(
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
    })
  );
}

module.exports = logger;