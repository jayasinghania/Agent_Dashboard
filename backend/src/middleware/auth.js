// src/middleware/auth.js
// ─────────────────────────────────────────────────────────────
//  Two layers of authentication:
//
//  1. requireApiSecret — verifies the request comes from YOUR
//     frontend (using a shared secret in the x-api-secret header).
//     This prevents random people on the internet from using
//     your backend.
//
//  2. requireSupabaseUser — verifies the user's Supabase JWT,
//     confirming they are logged in and fetching their role.
//     Attaches { id, email, role } to req.user.
// ─────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');
const { Errors } = require('../utils/errors');

// We create a separate anon client for JWT verification
// (the service-role client in utils/supabase bypasses auth checks)
const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  // Use service key so we can look up the user's profile
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

/**
 * Middleware: verifies the shared API secret sent from the frontend.
 * Frontend should include header: x-api-secret: <your API_SECRET>
 */
function requireApiSecret(req, res, next) {
  const secret = req.headers['x-api-secret'];
  if (!secret || secret !== process.env.API_SECRET) {
    logger.warn('Invalid or missing API secret', {
      ip: req.ip,
      path: req.path,
      hasHeader: !!secret,
    });
    return next(Errors.unauthorized('Missing or invalid API secret.'));
  }
  next();
}

/**
 * Middleware: verifies the Supabase JWT from the Authorization header.
 * Attaches req.user = { id, email, role } on success.
 *
 * Frontend should include: Authorization: Bearer <supabase_access_token>
 */
async function requireSupabaseUser(req, res, next) {
  try {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return next(Errors.unauthorized('Missing Bearer token.'));
    }

    // Verify the JWT with Supabase
    const { data: { user }, error } = await supabaseAuth.auth.getUser(token);

    if (error || !user) {
      logger.warn('Invalid Supabase token', { err: error?.message });
      return next(Errors.unauthorized('Invalid or expired session token.'));
    }

    // Fetch the user's profile to get their role
    const { data: profile, error: profileErr } = await supabaseAuth
      .from('profiles')
      .select('role, full_name')
      .eq('id', user.id)
      .single();

    if (profileErr || !profile) {
      logger.warn('Profile not found for authenticated user', { userId: user.id });
      return next(Errors.forbidden('User profile not found. Please contact your admin.'));
    }

    req.user = {
      id:       user.id,
      email:    user.email,
      role:     profile.role,
      fullName: profile.full_name,
    };

    logger.debug('User authenticated', { userId: user.id, role: profile.role });
    next();
  } catch (err) {
    logger.error('Unexpected auth error', { err: err.message, stack: err.stack });
    next(Errors.unauthorized('Authentication failed.'));
  }
}

/**
 * Middleware: ensures the authenticated user is an admin.
 * Must be used AFTER requireSupabaseUser.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    logger.warn('Non-admin tried to access admin route', {
      userId: req.user?.id,
      role:   req.user?.role,
      path:   req.path,
    });
    return next(Errors.forbidden('Admin access required.'));
  }
  next();
}

module.exports = { requireApiSecret, requireSupabaseUser, requireAdmin };