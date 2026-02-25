// src/services/syncService.js
// ─────────────────────────────────────────────────────────────
//  The heart of the caching system.
//
//  DB TABLE: public.conversations
//  Columns that matter:
//    conversation_id  text unique   ← ElevenLabs conversation ID
//    agent_db_id      uuid          ← our agents.id
//    agent_el_id      text          ← ElevenLabs agent ID
//    status           text
//    start_time_unix  bigint        ← used as the delta-sync checkpoint
//    duration_secs    integer
//    user_name        text
//    transcript       jsonb         ← array of { role, message, time_in_call_secs }
//    metadata         jsonb         ← full raw metadata from ElevenLabs
//    cost             numeric       ← from charging.cost
//    llm_cost         numeric       ← from charging.llm_cost
//    llm_price        numeric       ← from charging.llm_price
//    synced_at        timestamptz
// ─────────────────────────────────────────────────────────────

const supabase   = require('../utils/supabase');
const elevenlabs = require('./elevenlabs');
const logger     = require('../utils/logger');
const { Errors } = require('../utils/errors');

const DETAIL_BATCH_SIZE     = 8;
const DETAIL_BATCH_DELAY_MS = 150;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
/**
 * Main sync function.
 *
 * 1. Finds the newest start_time_unix already stored for this agent.
 * 2. Fetches only conversations newer than that from ElevenLabs.
 * 3. For each new conv, fetches full detail (transcript, charging, etc.).
 * 4. Upserts rows into `conversations`.
 * 5. Updates agents.last_synced_at.
 * 6. Returns { newCount, totalCount, lastSyncedAt }.
 */
async function syncConversations(agentDbId, agentElId, apiKey) {
  logger.info('Starting conversation sync', { agentDbId, agentElId });

  // ── Step 1: Find the delta-sync checkpoint ────────────────
  const { data: latest, error: latestErr } = await supabase
    .from('conversations')
    .select('start_time_unix')
    .eq('agent_db_id', agentDbId)
    .order('start_time_unix', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestErr) {
    logger.error('Failed to query sync checkpoint', { err: latestErr.message });
    throw Errors.database('Could not read conversation cache', { err: latestErr.message });
  }

  const stopBeforeUnix = latest?.start_time_unix || null;
  logger.info('Sync checkpoint', {
    agentDbId,
    stopBeforeUnix,
    stopBeforeDate: stopBeforeUnix
      ? new Date(stopBeforeUnix * 1000).toISOString()
      : 'none — first sync, fetching everything',
  });

  // ── Step 2: Fetch new conversations from ElevenLabs ───────
  const newConvs = await elevenlabs.fetchAllConversations(apiKey, agentElId, stopBeforeUnix);

  if (!newConvs.length) {
    logger.info('Sync complete — no new conversations', { agentDbId });
    const { count } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('agent_db_id', agentDbId);
    return { newCount: 0, totalCount: count || 0, lastSyncedAt: new Date().toISOString() };
  }

  logger.info(`Fetching details for ${newConvs.length} new conversations`, { agentDbId });

  // ── Step 3: Fetch full details in batches ─────────────────
  const detailedConvs = [];

  for (let i = 0; i < newConvs.length; i += DETAIL_BATCH_SIZE) {
    const batch = newConvs.slice(i, i + DETAIL_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(c => elevenlabs.fetchConversationDetail(apiKey, c.conversation_id))
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled' && r.value) {
        detailedConvs.push({ list: batch[j], detail: r.value });
      } else {
        logger.warn('Failed to fetch conversation detail', {
          conversationId: batch[j].conversation_id,
          reason: r.reason?.message || 'unknown',
        });
        // Still store list-level data — better than losing it entirely
        detailedConvs.push({ list: batch[j], detail: null });
      }
    }

    if (i + DETAIL_BATCH_SIZE < newConvs.length) {
      await sleep(DETAIL_BATCH_DELAY_MS);
    }
  }

  // ── Step 4: Build rows and upsert into `conversations` ────
  const rows = detailedConvs.map(({ list, detail }) => buildRow(agentDbId, agentElId, list, detail));

  const { error: upsertErr } = await supabase
    .from('conversations')
    .upsert(rows, { onConflict: 'conversation_id' });

  if (upsertErr) {
    logger.error('Failed to upsert conversations', { err: upsertErr.message });
    throw Errors.database('Failed to save conversations', { err: upsertErr.message });
  }

  // ── Step 5: Update agents.last_synced_at ──────────────────
  await supabase
    .from('agents')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('id', agentDbId);

  // ── Step 6: Return summary ────────────────────────────────
  const { count: totalCount } = await supabase
    .from('conversations')
    .select('*', { count: 'exact', head: true })
    .eq('agent_db_id', agentDbId);

  logger.info('Sync complete', { agentDbId, newCount: rows.length, totalCount });

  return {
    newCount:     rows.length,
    totalCount:   totalCount || 0,
    lastSyncedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
/**
 * Builds a row matching the `conversations` table schema exactly.
 * Maps ElevenLabs API response fields → our column names.
 */
function buildRow(agentDbId, agentElId, listItem, detail) {
  const meta     = detail?.metadata || listItem?.metadata || {};
  const charging = detail?.charging || meta?.charging     || {};
  const tr       = detail?.transcript || [];

  // Extract user name from dynamic variables or agent greeting
  const userName = extractUserName(detail, tr);

  return {
    conversation_id: listItem.conversation_id,
    agent_db_id:     agentDbId,
    agent_el_id:     agentElId || null,
    status:          detail?.status || listItem?.status || null,
    start_time_unix: meta.start_time_unix_secs || listItem?.metadata?.start_time_unix_secs || null,
    duration_secs:   meta.call_duration_secs   || listItem?.metadata?.call_duration_secs   || null,
    user_name:       userName,
    // jsonb columns — pass objects directly (no JSON.stringify needed for jsonb)
    transcript:      tr.length ? tr : [],
    metadata:        Object.keys(meta).length ? meta : {},
    // Cost fields — pulled from charging object
    cost:            charging.cost      != null ? Number(charging.cost)      : null,
    llm_cost:        charging.llm_cost  != null ? Number(charging.llm_cost)  : null,
    llm_price:       charging.llm_price != null ? Number(charging.llm_price) : null,
    synced_at:       new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
/**
 * Extracts the user's name from dynamic variables or the transcript.
 */
function extractUserName(detail, transcript) {
  // Try dynamic variables first (most reliable)
  const dv = detail?.conversation_initiation_client_data?.dynamic_variables;
  if (dv) {
    if (dv.user_name) return dv.user_name;
    for (const k of Object.keys(dv)) {
      if (k.toLowerCase().includes('name') || k.toLowerCase().includes('user')) {
        if (dv[k] && typeof dv[k] === 'string' && dv[k].length < 40) return dv[k];
      }
    }
  }

  // Fall back to scanning agent greeting for a name
  for (const t of (transcript || []).slice(0, 20)) {
    if (t.role === 'agent' && t.message) {
      const m = t.message.match(/\b(?:hey|hello|hi)\s+([A-Z][a-z]{1,30})\b/i);
      if (m) return m[1];
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
/**
 * Reads all stored conversations for an agent from the DB.
 * Fast path — no ElevenLabs call needed.
 */
async function getConversations(agentDbId, options = {}) {
  const { limit = 500, offset = 0 } = options;

  const { data, error, count } = await supabase
    .from('conversations')
    .select('*', { count: 'exact' })
    .eq('agent_db_id', agentDbId)
    .order('start_time_unix', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    logger.error('Failed to read conversations', { err: error.message });
    throw Errors.database('Failed to read conversations', { err: error.message });
  }

  return { conversations: data || [], total: count || 0 };
}

module.exports = { syncConversations, getConversations, buildRow };