// src/routes/conversations.js
// ─────────────────────────────────────────────────────────────
//  POST /api/conversations/sync/:agentId
//    → Syncs new conversations from ElevenLabs (delta sync).
//
//  DELETE /api/conversations/reset/:agentId
//    → Wipes all cached conversations for an agent so a full
//      re-sync can be triggered (admin only).
//      Use when cost/token data is missing from old syncs.
//
//  GET  /api/conversations/:agentId
//    → Returns all cached conversations from DB.
//
//  GET  /api/conversations/:agentId/:conversationId
//    → Returns full detail of one conversation.
// ─────────────────────────────────────────────────────────────

const express  = require('express');
const router   = express.Router();
const supabase = require('../utils/supabase');
const { asyncHandler, Errors } = require('../utils/errors');
const { requireSupabaseUser } = require('../middleware/auth');
const syncService = require('../services/syncService');
const logger = require('../utils/logger');

router.use(requireSupabaseUser);

// ── Helper: verify user has access to this agent ──────────────
async function getAgentForUser(agentDbId, user) {
  if (user.role === 'admin') {
    const { data, error } = await supabase
      .from('agents')
      .select('id, name, agent_id, api_key, last_synced_at')
      .eq('id', agentDbId)
      .single();
    if (error || !data) throw Errors.notFound('Agent not found.');
    return data;
  } else {
    const { data, error } = await supabase
      .from('agent_access')
      .select('agents(id, name, agent_id, api_key, last_synced_at)')
      .eq('user_id', user.id)
      .eq('agent_id', agentDbId)
      .single();
    if (error || !data?.agents) throw Errors.forbidden('You do not have access to this agent.');
    return data.agents;
  }
}

// ──────────────────────────────────────────────────────────────
// POST /api/conversations/sync/:agentId
// Delta sync — only fetches conversations newer than last sync.
// ──────────────────────────────────────────────────────────────
router.post('/sync/:agentId', asyncHandler(async (req, res) => {
  const { agentId } = req.params;

  if (req.user.role !== 'admin') {
    throw Errors.forbidden('Only admins can trigger conversation syncs.');
  }

  const agent = await getAgentForUser(agentId, req.user);

  if (!agent.api_key) {
    throw Errors.badRequest('This agent has no API key configured. Add one in the dashboard first.');
  }

  logger.info('Sync triggered', { agentId, agentName: agent.name, userId: req.user.id });

  const result = await syncService.syncConversations(
    agent.id,
    agent.agent_id,
    agent.api_key
  );

  res.json({
    success: true,
    data: {
      newCount:     result.newCount,
      totalCount:   result.totalCount,
      lastSyncedAt: result.lastSyncedAt,
      agentId:      agent.id,
      agentName:    agent.name,
    },
    message: result.newCount > 0
      ? `Synced ${result.newCount} new conversation${result.newCount !== 1 ? 's' : ''}.`
      : 'Already up to date — no new conversations.',
  });
}));

// ──────────────────────────────────────────────────────────────
// DELETE /api/conversations/reset/:agentId
// Wipes all cached conversations so a full re-sync can be done.
// This fixes old rows with missing cost/token data.
// Admin only.
// ──────────────────────────────────────────────────────────────
router.delete('/reset/:agentId', asyncHandler(async (req, res) => {
  const { agentId } = req.params;

  if (req.user.role !== 'admin') {
    throw Errors.forbidden('Only admins can reset conversation cache.');
  }

  const agent = await getAgentForUser(agentId, req.user);

  logger.info('Resetting conversation cache', { agentId, agentName: agent.name, userId: req.user.id });

  // Delete all cached conversations for this agent
  const { error } = await supabase
    .from('conversations')
    .delete()
    .eq('agent_db_id', agent.id);

  if (error) throw Errors.database('Failed to reset conversation cache.', { err: error.message });

  // Also clear last_synced_at so next sync fetches everything
  await supabase
    .from('agents')
    .update({ last_synced_at: null })
    .eq('id', agent.id);

  logger.info('Cache reset complete', { agentId, agentName: agent.name });

  res.json({
    success: true,
    message: `Cache cleared for agent "${agent.name}". Run sync to re-fetch all conversations.`,
    data: { agentId: agent.id },
  });
}));

// ──────────────────────────────────────────────────────────────
// GET /api/conversations/:agentId
// Returns all stored conversations for an agent (from DB).
// ──────────────────────────────────────────────────────────────
router.get('/:agentId', asyncHandler(async (req, res) => {
  const { agentId } = req.params;
  const limit  = Math.min(parseInt(req.query.limit  || '500', 10), 1000);
  const offset = parseInt(req.query.offset || '0', 10);

  const agent = await getAgentForUser(agentId, req.user);

  const { conversations, total } = await syncService.getConversations(agent.id, { limit, offset });

  res.json({
    success: true,
    data: {
      conversations,
      total,
      limit,
      offset,
      agentId:      agent.id,
      lastSyncedAt: agent.last_synced_at,
    },
  });
}));

// ──────────────────────────────────────────────────────────────
// GET /api/conversations/:agentId/:conversationId
// Returns full detail of one stored conversation.
// ──────────────────────────────────────────────────────────────
router.get('/:agentId/:conversationId', asyncHandler(async (req, res) => {
  const { agentId, conversationId } = req.params;

  const agent = await getAgentForUser(agentId, req.user);

  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('agent_db_id', agent.id)
    .eq('conversation_id', conversationId)
    .single();

  if (error || !data) {
    throw Errors.notFound(`Conversation ${conversationId} not found. Try syncing first.`);
  }

  res.json({ success: true, data });
}));

module.exports = router;