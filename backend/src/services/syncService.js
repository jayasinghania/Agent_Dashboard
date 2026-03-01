// src/services/syncService.js
// ─────────────────────────────────────────────────────────────
//  DB TABLE: public.conversations
//  Columns:
//    conversation_id          text unique
//    agent_db_id              uuid
//    agent_el_id              text
//    status                   text
//    start_time_unix          bigint
//    duration_secs            integer
//    user_name                text
//    transcript               jsonb
//    metadata                 jsonb      ← full raw detail from ElevenLabs
//    cost                     numeric    ← detail.metadata.cost
//    llm_cost                 numeric    ← detail.metadata.charging.llm_charge
//    llm_price                numeric    ← detail.metadata.charging.llm_price
//    transcript_summary       text       ← detail.analysis.transcript_summary
//    confidence_score         jsonb      ← detail.analysis.evaluation_criteria_results.confidence_score
//    knowledge_coverage_score jsonb      ← detail.analysis.evaluation_criteria_results.knowledge_coverage_score
//    primary_question         text       ← detail.analysis.data_collection_results.primary_question.value
//    question_category        text       ← detail.analysis.data_collection_results.question_category.value
//    synced_at                timestamptz
//
//  REQUIRED SUPABASE MIGRATION (run once):
//    ALTER TABLE conversations
//      ADD COLUMN IF NOT EXISTS transcript_summary       text,
//      ADD COLUMN IF NOT EXISTS confidence_score         jsonb,
//      ADD COLUMN IF NOT EXISTS knowledge_coverage_score jsonb,
//      ADD COLUMN IF NOT EXISTS primary_question         text,
//      ADD COLUMN IF NOT EXISTS question_category        text;
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
 * 1. Find newest start_time_unix already stored.
 * 2. Fetch only newer conversations from ElevenLabs.
 * 3. Fetch full detail for each (transcript, charging, tokens).
 * 4. Upsert into conversations table.
 * 5. Update agents.last_synced_at.
 */
async function syncConversations(agentDbId, agentElId, apiKey) {
  logger.info('Starting conversation sync', { agentDbId, agentElId });

  // ── Step 1: Delta-sync checkpoint ────────────────────────
  const { data: latest, error: latestErr } = await supabase
    .from('conversations')
    .select('start_time_unix')
    .eq('agent_db_id', agentDbId)
    .order('start_time_unix', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestErr) throw Errors.database('Could not read conversation cache', { err: latestErr.message });

  const stopBeforeUnix = latest?.start_time_unix || null;
  logger.info('Sync checkpoint', {
    agentDbId,
    stopBeforeUnix,
    stopBeforeDate: stopBeforeUnix ? new Date(stopBeforeUnix * 1000).toISOString() : 'none — first sync',
  });

  // ── Step 2: Fetch new conversations from ElevenLabs ──────
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
        detailedConvs.push({ list: batch[j], detail: null });
      }
    }

    if (i + DETAIL_BATCH_SIZE < newConvs.length) {
      await sleep(DETAIL_BATCH_DELAY_MS);
    }
  }

  // ── Step 4: Build rows and upsert ─────────────────────────
  const rows = detailedConvs.map(({ list, detail }) => buildRow(agentDbId, agentElId, list, detail));

  // Log a sample row so we can verify field mapping in Railway logs
  if (rows.length > 0) {
    const sample = rows[0];
    logger.info('Sample row (first conversation):', {
      conversation_id:          sample.conversation_id,
      cost:                     sample.cost,
      llm_cost:                 sample.llm_cost,
      llm_price:                sample.llm_price,
      has_transcript:           sample.transcript?.length > 0,
      has_metadata:             Object.keys(sample.metadata || {}).length > 0,
      transcript_summary:       sample.transcript_summary ? 'present' : null,
      confidence_score:         sample.confidence_score   ? sample.confidence_score.result : null,
      knowledge_coverage_score: sample.knowledge_coverage_score ? sample.knowledge_coverage_score.result : null,
      primary_question:         sample.primary_question,
      question_category:        sample.question_category,
    });
  }

  const { error: upsertErr } = await supabase
    .from('conversations')
    .upsert(rows, { onConflict: 'conversation_id' });

  if (upsertErr) throw Errors.database('Failed to save conversations', { err: upsertErr.message });

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
 * Builds one DB row from ElevenLabs API response.
 *
 * ElevenLabs detail response shape (verified):
 * {
 *   conversation_id: "conv_xxx",
 *   status: "done",
 *   transcript: [...],
 *   metadata: {
 *     start_time_unix_secs: 1234567890,
 *     call_duration_secs: 120,
 *     cost: 0.0042,              ← TOTAL cost
 *     charging: {
 *       llm_charge: 0.0021,      ← LLM portion
 *       llm_price:  0.001,
 *       llm_usage: {
 *         irreversible_generation: {
 *           model_usage: {
 *             input:        { tokens: 500 },
 *             output_total: { tokens: 200 },
 *           }
 *         },
 *         initiated_generation: {
 *           model_usage: {
 *             input:        { tokens: 100 },
 *             output_total: { tokens:  50 },
 *           }
 *         }
 *       }
 *     }
 *   },
 *   analysis: {
 *     transcript_summary: "User asked about...",
 *     evaluation_criteria_results: {
 *       confidence_score: {
 *         criteria_id:  "confidence_score",
 *         result:       "success" | "failure" | "unknown",
 *         rationale:    "The agent responded confidently...",
 *       },
 *       knowledge_coverage_score: {
 *         criteria_id:  "knowledge_coverage_score",
 *         result:       "success" | "failure" | "unknown",
 *         rationale:    "The agent covered...",
 *       },
 *     },
 *     data_collection_results: {
 *       primary_question: {
 *         data_collection_id: "primary_question",
 *         value: "What is the leave policy?",
 *       },
 *       question_category: {
 *         data_collection_id: "question_category",
 *         value: "Company",
 *       },
 *     },
 *   },
 *   conversation_initiation_client_data: {
 *     dynamic_variables: { user_name: "..." }
 *   }
 * }
 */
function buildRow(agentDbId, agentElId, listItem, detail) {
  // ── Pull from correct paths ───────────────────────────────
  const meta     = detail?.metadata     || listItem?.metadata || {};
  const charging = meta?.charging       || {};
  const tr       = detail?.transcript   || [];

  // ── Token extraction ──────────────────────────────────────
  // model_usage is keyed by model name (e.g. 'gpt-4.1-nano') — must use Object.values()[0]
  // Use irreversible_generation only — initiated_generation duplicates the same counts
  const llmUsage   = charging?.llm_usage || {};
  const irrevModel = Object.values(llmUsage?.irreversible_generation?.model_usage || {})[0] || {};

  const tokensIn  = irrevModel?.input?.tokens        || 0;
  const tokensOut = irrevModel?.output_total?.tokens || 0;

  // ── Analysis extraction ───────────────────────────────────
  // detail.analysis contains evaluation criteria, data collection, and transcript summary
  const analysis    = detail?.analysis || {};
  const evalResults = analysis?.evaluation_criteria_results || {};
  const dataResults = analysis?.data_collection_results     || {};

  // Evaluation criteria — stored as jsonb { result, rationale }
  const confidenceScore         = evalResults?.confidence_score         || null;
  const knowledgeCoverageScore  = evalResults?.knowledge_coverage_score || null;

  // Data collection — stored as plain text values
  const primaryQuestion  = dataResults?.primary_question?.value  ?? null;
  const questionCategory = dataResults?.question_category?.value ?? null;

  // Transcript summary — stored as text
  const transcriptSummary = analysis?.transcript_summary ?? null;

  logger.debug('buildRow charging data', {
    conversation_id: listItem.conversation_id,
    raw_cost:        meta?.cost,
    raw_llm_charge:  charging?.llm_charge,
    raw_llm_price:   charging?.llm_price,
    tokens_in:       tokensIn,
    tokens_out:      tokensOut,
    charging_keys:   Object.keys(charging),
    meta_keys:       Object.keys(meta),
    has_analysis:    Object.keys(analysis).length > 0,
    has_eval:        Object.keys(evalResults).length > 0,
    has_data_coll:   Object.keys(dataResults).length > 0,
  });

  return {
    conversation_id: listItem.conversation_id,
    agent_db_id:     agentDbId,
    agent_el_id:     agentElId || null,
    status:          detail?.status || listItem?.status || null,
    start_time_unix: meta?.start_time_unix_secs || listItem?.metadata?.start_time_unix_secs || null,
    duration_secs:   meta?.call_duration_secs   || listItem?.metadata?.call_duration_secs   || null,
    user_name:       extractUserName(detail, tr),

    // jsonb columns — store the full objects
    transcript: tr.length ? tr : [],
    metadata:   Object.keys(meta).length ? meta : {},

    // ── Cost fields ───────────────────────────────────────
    cost:      meta?.cost           != null ? Number(meta.cost)            : null,
    llm_cost:  charging?.llm_charge != null ? Number(charging.llm_charge)  : null,
    llm_price: charging?.llm_price  != null ? Number(charging.llm_price)   : null,

    // ── Analysis fields ───────────────────────────────────
    // Stored in DB only — not displayed on dashboard
    transcript_summary:       transcriptSummary,
    confidence_score:         confidenceScore,         // jsonb: { result, rationale }
    knowledge_coverage_score: knowledgeCoverageScore,  // jsonb: { result, rationale }
    primary_question:         primaryQuestion,          // text
    question_category:        questionCategory,         // text

    synced_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
/**
 * Extract user name from dynamic variables or transcript greeting.
 */
function extractUserName(detail, transcript) {
  const dv = detail?.conversation_initiation_client_data?.dynamic_variables;
  if (dv) {
    if (dv.user_name) return dv.user_name;
    for (const k of Object.keys(dv)) {
      if (k.toLowerCase().includes('name') || k.toLowerCase().includes('user')) {
        if (dv[k] && typeof dv[k] === 'string' && dv[k].length < 40) return dv[k];
      }
    }
  }
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
 * Read all stored conversations for an agent from DB.
 */
async function getConversations(agentDbId, options = {}) {
  const { limit = 500, offset = 0 } = options;

  const { data, error, count } = await supabase
    .from('conversations')
    .select('*', { count: 'exact' })
    .eq('agent_db_id', agentDbId)
    .order('start_time_unix', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw Errors.database('Failed to read conversations', { err: error.message });

  return { conversations: data || [], total: count || 0 };
}

module.exports = { syncConversations, getConversations, buildRow };