// src/routes/auth.js
// ─────────────────────────────────────────────────────────────
//  Authentication endpoints — all auth flows go through the
//  backend rather than calling Supabase directly from the browser.
//
//  POST /api/auth/signup   → create account
//  POST /api/auth/signin   → sign in, return session tokens
//  POST /api/auth/signout  → invalidate session (requires Bearer)
// ─────────────────────────────────────────────────────────────

const express  = require('express');
const router   = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { asyncHandler, Errors } = require('../utils/errors');
const { requireSupabaseUser } = require('../middleware/auth');
const logger = require('../utils/logger');

// Use the service-role client so we can also look up profiles
const sbAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ── POST /api/auth/signup ─────────────────────────────────────
router.post('/signup', asyncHandler(async (req, res) => {
  const { email, password, full_name } = req.body;
  if (!email)     throw Errors.badRequest('Email is required.');
  if (!password)  throw Errors.badRequest('Password is required.');
  if (password.length < 8) throw Errors.badRequest('Password must be at least 8 characters.');

  // Create the user via Supabase Auth (service-role can skip email confirm if needed)
  const { data, error } = await sbAdmin.auth.admin.createUser({
    email,
    password,
    user_metadata: { full_name: full_name || '' },
    email_confirm: false,   // set to true if you want mandatory email confirmation
  });

  if (error) {
    // Surface common errors helpfully
    if (error.message?.toLowerCase().includes('already registered')) {
      throw Errors.badRequest('An account with this email already exists.');
    }
    throw Errors.badRequest(error.message || 'Failed to create account.');
  }

  const user = data.user;
  logger.info('New user created via backend', { userId: user.id, email: user.email });

  // ── Upsert profile row ──────────────────────────────────────
  // Determine role: first user ever becomes admin
  const { count } = await sbAdmin
    .from('profiles')
    .select('*', { count: 'exact', head: true });

  const role = count === 0 ? 'admin' : 'client';

  await sbAdmin.from('profiles').upsert({
    id:        user.id,
    email:     user.email,
    full_name: full_name || '',
    role,
  });

  // Apply any pending invite role
  const { data: invite } = await sbAdmin
    .from('pending_invites')
    .select('role')
    .eq('email', email)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (invite) {
    await sbAdmin.from('profiles').update({ role: invite.role }).eq('id', user.id);
    await sbAdmin.from('pending_invites').delete().eq('email', email);
    logger.info('Applied pending invite role', { email, role: invite.role });
  }

  res.status(201).json({
    success: true,
    message: 'Account created successfully.',
    data: {
      userId: user.id,
      email:  user.email,
      role:   invite?.role || role,
    },
  });
}));

// ── POST /api/auth/signin ─────────────────────────────────────
router.post('/signin', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email)    throw Errors.badRequest('Email is required.');
  if (!password) throw Errors.badRequest('Password is required.');

  // Use anon client with user credentials (not service-role) so RLS is respected
  const sbAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data, error } = await sbAnon.auth.signInWithPassword({ email, password });

  if (error) {
    // Avoid leaking whether the email exists
    if (error.message?.toLowerCase().includes('invalid login')) {
      throw Errors.unauthorized('Invalid email or password.');
    }
    throw Errors.unauthorized(error.message || 'Sign in failed.');
  }

  const { session, user } = data;

  // Fetch profile for role info
  const { data: profile } = await sbAdmin
    .from('profiles')
    .select('role, full_name')
    .eq('id', user.id)
    .single();

  logger.info('User signed in', { userId: user.id, role: profile?.role });

  res.json({
    success: true,
    data: {
      accessToken:  session.access_token,
      refreshToken: session.refresh_token,
      expiresAt:    session.expires_at,
      user: {
        id:       user.id,
        email:    user.email,
        fullName: profile?.full_name || '',
        role:     profile?.role || 'client',
      },
    },
  });
}));

// ── POST /api/auth/signout ────────────────────────────────────
router.post('/signout', requireSupabaseUser, asyncHandler(async (req, res) => {
  // Get the token from the header and invalidate it
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (token) {
    const sbAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    // Set the session then sign out to invalidate the refresh token server-side
    await sbAnon.auth.setSession({ access_token: token, refresh_token: '' }).catch(() => {});
    await sbAnon.auth.signOut().catch(() => {});
  }
  logger.info('User signed out', { userId: req.user?.id });
  res.json({ success: true, message: 'Signed out successfully.' });
}));

module.exports = router;