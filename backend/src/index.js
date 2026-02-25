// src/index.js
// ─────────────────────────────────────────────────────────────
//  Indoo Backend — Express server entry point
//
//  Startup order:
//  1. Load env vars
//  2. Set up Express with security middleware
//  3. Register routes
//  4. Register error handler (always last)
//  5. Start listening
// ─────────────────────────────────────────────────────────────

require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');
const logger      = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const { requireApiSecret } = require('./middleware/auth');

// ── Route handlers ────────────────────────────────────────────
const agentsRouter        = require('./routes/agents');
const conversationsRouter = require('./routes/conversations');

// ── Validate critical env vars on startup ────────────────────
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'API_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  logger.error(`Missing required environment variables: ${missing.join(', ')}`);
  logger.error('Copy .env.example to .env and fill in your values.');
  process.exit(1);
}

// ── App setup ─────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3001;

// Trust proxy headers (needed when deployed behind Vercel/Railway/Render)
app.set('trust proxy', 1);

// ── CORS ──────────────────────────────────────────────────────
// Only the origins in ALLOWED_ORIGINS can call this API
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. curl, Postman during dev)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    logger.warn('CORS blocked request', { origin });
    callback(new Error(`CORS: origin ${origin} is not allowed`));
  },
  credentials: true,
}));

// ── Body parsing ──────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── HTTP request logging ──────────────────────────────────────
// Uses Winston stream so all logs go through the same logger
app.use(morgan('combined', {
  stream: { write: msg => logger.http(msg.trim()) },
  skip: (req) => req.path === '/health', // don't log health checks
}));

// ── Rate limiting ─────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  max:      parseInt(process.env.RATE_LIMIT_MAX        || '100',   10),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } },
  handler: (req, res, next, options) => {
    logger.warn('Rate limit hit', { ip: req.ip, path: req.path });
    res.status(options.statusCode).json(options.message);
  },
});
app.use('/api/', limiter);

// ── Health check (no auth needed) ────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), env: process.env.NODE_ENV });
});

// ── API routes (all require the shared API secret) ────────────
app.use('/api/', requireApiSecret);
app.use('/api/agents',        agentsRouter);
app.use('/api/conversations',  conversationsRouter);

// ── 404 handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found.` },
  });
});

// ── Global error handler (always last) ───────────────────────
app.use(errorHandler);

// ── Start server ──────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info('────────────────────────────────────────');
  logger.info(`🚀 Indoo backend running on port ${PORT}`);
  logger.info(`   Environment : ${process.env.NODE_ENV || 'development'}`);
  logger.info(`   Supabase    : ${process.env.SUPABASE_URL}`);
  logger.info(`   CORS origins: ${allowedOrigins.join(', ') || '(none)'}`);
  logger.info('────────────────────────────────────────');
});

// ── Unhandled rejection safety net ───────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', { reason: String(reason), promise: String(promise) });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception — shutting down', { err: err.message, stack: err.stack });
  process.exit(1);
});

module.exports = app;