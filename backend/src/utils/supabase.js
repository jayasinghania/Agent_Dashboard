// src/utils/supabase.js
// ─────────────────────────────────────────────────────────────
//  Backend Supabase client.
//  Uses the SERVICE ROLE key so it can bypass RLS where needed
//  (e.g. syncing conversations on behalf of any agent/user).
//  This client MUST stay server-side only — never expose the
//  service role key to the browser.
// ─────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  logger.error('Missing Supabase env vars: SUPABASE_URL and/or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: {
    autoRefreshToken: false,
    persistSession:   false,
  },
});

module.exports = supabase;