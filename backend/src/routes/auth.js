// src/routes/auth.js
// ─────────────────────────────────────────────────────────────
//  Authentication endpoints — all auth flows go through the
//  backend rather than calling Supabase directly from the browser.
//
//  POST   /api/auth/signup      → create account
//  POST   /api/auth/signin      → sign in, return session tokens
//  POST   /api/auth/signout     → invalidate session (requires Bearer)
//  DELETE /api/auth/users/:id   → permanently delete a user (admin only)
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

  // Step 1: Create the user in Supabase Auth
  // The DB trigger handle_new_user() will auto-create the profile row
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

  // Step 2: Wait for the DB trigger to create the profile
  // The trigger handle_new_user() fires on auth.users INSERT and creates the profile row.
  // We poll briefly because the trigger runs asynchronously.
  let profile = null;
  for (let i = 0; i < 8; i++) {
    const { data: p } = await sbAdmin
      .from('profiles')
      .select('role, full_name')
      .eq('id', user.id)
      .single();
    if (p) { profile = p; break; }
    await new Promise(r => setTimeout(r, 300));
  }

  // Step 3: If trigger created the profile but full_name is empty, update it
  if (profile && full_name && !profile.full_name) {
    await sbAdmin.from('profiles').update({ full_name }).eq('id', user.id);
  }

  // Step 4: Apply any pending invite role (overrides the trigger's default)
  const { data: invite } = await sbAdmin
    .from('pending_invites')
    .select('role')
    .eq('email', email)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let finalRole = profile?.role || 'client';

  if (invite) {
    await sbAdmin.from('profiles').update({ role: invite.role }).eq('id', user.id);
    await sbAdmin.from('pending_invites').delete().eq('email', email);
    finalRole = invite.role;
    logger.info('Applied pending invite role', { email, role: invite.role });
  }

  res.status(201).json({
    success: true,
    message: 'Account created successfully.',
    data: {
      userId: user.id,
      email:  user.email,
      role:   finalRole,
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
    await sbAdmin.auth.admin.signOut(req.user.id).catch(() => {});
  }
  logger.info('User signed out', { userId: req.user?.id });
  res.json({ success: true, message: 'Signed out successfully.' });
}));

// ── DELETE /api/auth/users/:id ────────────────────────────────
// Permanently removes a user (auth row + profile + access).
// Admin only. The ON DELETE CASCADE on profiles handles cleanup.
router.delete('/users/:id', requireSupabaseUser, asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') {
    throw Errors.forbidden('Only admins can delete users.');
  }
  if (req.params.id === req.user.id) {
    throw Errors.badRequest('You cannot delete your own account.');
  }

  // Delete from Supabase Auth — cascades to profiles via FK
  const { error } = await sbAdmin.auth.admin.deleteUser(req.params.id);
  if (error) {
    throw Errors.database('Failed to delete user from auth system.', { err: error.message });
  }

  logger.info('User permanently deleted', { deletedId: req.params.id, byAdmin: req.user.id });
  res.json({ success: true, message: 'User permanently removed.' });
}));

module.exports = router;