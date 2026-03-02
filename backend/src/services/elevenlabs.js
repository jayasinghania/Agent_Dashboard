// src/services/elevenlabs.js
// ─────────────────────────────────────────────────────────────
//  All direct calls to the ElevenLabs Conversational AI API
//  live here. The rest of the app never calls ElevenLabs
//  directly — it goes through these functions.
//
//  Benefits:
//  • One place to update if the ElevenLabs API changes
//  • Consistent error handling & logging for external calls
//  • Easy to mock in tests
// ─────────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const logger = require('../utils/logger');
const { Errors } = require('../utils/errors');

const BASE = 'https://api.elevenlabs.io/v1/convai';

// ── Internal helper ───────────────────────────────────────────
async function elFetch(path, apiKey, options = {}) {
  const url = `${BASE}${path}`;
  logger.debug('ElevenLabs request', { url, method: options.method || 'GET' });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30-second timeout

  let res;
  try {
    res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (networkErr) {
    clearTimeout(timeoutId);
    // Timeout hit — AbortController fired
    if (networkErr.name === 'AbortError') {
      logger.error('ElevenLabs request timed out', { url });
      throw Errors.elevenlabs(
        'ElevenLabs API request timed out after 30 seconds. Please try again.',
        { originalError: 'AbortError', url }
      );
    }
    // Network-level failure (DNS, connection refused, etc.)
    logger.error('ElevenLabs network error', { url, err: networkErr.message });
    throw Errors.elevenlabs(
      'Could not reach ElevenLabs API — check your network connection.',
      { originalError: networkErr.message }
    );
  } finally {
    clearTimeout(timeoutId);
  }

  // Non-2xx response
  if (!res.ok) {
    let body = {};
    try { body = await res.json(); } catch { /* ignore parse errors */ }

    const msg = body?.detail?.message || body?.message || `ElevenLabs API error ${res.status}`;
    logger.warn('ElevenLabs non-OK response', { url, status: res.status, body });

    // Map common status codes to helpful messages
    if (res.status === 401) throw Errors.elevenlabs('Invalid ElevenLabs API key.', { status: 401 });
    if (res.status === 403) throw Errors.elevenlabs('ElevenLabs API key lacks permission for this action.', { status: 403 });
    if (res.status === 404) throw Errors.notFound(`ElevenLabs resource not found: ${path}`);
    if (res.status === 429) throw Errors.tooMany('ElevenLabs rate limit hit. Please wait and retry.');
    throw Errors.elevenlabs(msg, { status: res.status, body });
  }

  const data = await res.json();
  logger.debug('ElevenLabs response OK', { url, status: res.status });
  return data;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Fetch one page of conversations.
 * @param {string} apiKey
 * @param {string} [agentId]  - Filter by agent ID (optional)
 * @param {string} [cursor]   - Pagination cursor
 * @param {number} [pageSize] - Max results per page (default 100)
 */
async function fetchConversationPage(apiKey, agentId = null, cursor = null, pageSize = 100) {
  const params = new URLSearchParams({ page_size: String(pageSize) });
  if (agentId) params.append('agent_id', agentId);
  if (cursor)  params.append('cursor', cursor);
  return elFetch(`/conversations?${params}`, apiKey);
}

/**
 * Fetch ALL conversations, following pagination cursors.
 * Stops early when it encounters a conversation older than `stopBeforeUnix`.
 *
 * @param {string} apiKey
 * @param {string} agentId
 * @param {number|null} stopBeforeUnix - Unix timestamp; stop fetching when we reach older convs
 * @param {number} maxPages - Safety cap (default 20 = up to 2000 conversations)
 */
async function fetchAllConversations(apiKey, agentId, stopBeforeUnix = null, maxPages = 20) {
  const allConversations = [];
  let cursor  = null;
  let page    = 0;
  let stopped = false;

  const MAX_CONVERSATIONS = 2000; // safety cap to prevent memory exhaustion

  logger.info('Starting ElevenLabs conversation fetch', {
    agentId,
    stopBeforeUnix,
    stopBeforeDate: stopBeforeUnix ? new Date(stopBeforeUnix * 1000).toISOString() : null,
  });

  do {
    const data = await fetchConversationPage(apiKey, agentId, cursor);
    const convs = data.conversations || [];

    if (!convs.length) break;

    for (const conv of convs) {
      const startTime =
        conv.metadata?.start_time_unix_secs ||
        conv.start_time_unix_secs || null;

      // FIX: Changed <= to < so conversations with the exact same timestamp
      // as the checkpoint are still fetched (upsert handles duplicates safely)
      if (stopBeforeUnix && startTime && startTime < stopBeforeUnix) {
        stopped = true;
        break;
      }
      allConversations.push(conv);

      // FIX: Memory safety cap — stop if we've accumulated too many
      if (allConversations.length >= MAX_CONVERSATIONS) {
        logger.warn('Hit conversation safety cap', { max: MAX_CONVERSATIONS, agentId });
        stopped = true;
        break;
      }
    }

    if (stopped) break;

    cursor = data.next_cursor || data.cursor || null;
    page++;

    // Small delay between pages to be kind to the rate limiter
    if (cursor && page < maxPages) await sleep(100);

  } while (cursor && page < maxPages);

  logger.info('ElevenLabs fetch complete', {
    agentId,
    totalFetched: allConversations.length,
    pages: page,
    stoppedEarly: stopped,
  });

  return allConversations;
}

/**
 * Fetch the full detail of a single conversation (includes transcript).
 * @param {string} apiKey
 * @param {string} conversationId
 */
async function fetchConversationDetail(apiKey, conversationId) {
  return elFetch(`/conversations/${conversationId}`, apiKey);
}

// ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = {
  fetchConversationPage,
  fetchAllConversations,
  fetchConversationDetail,
};