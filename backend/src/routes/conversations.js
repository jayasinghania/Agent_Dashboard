// src/routes/conversations.js
// ─────────────────────────────────────────────────────────────
//  Conversation endpoints:
//
//  POST /api/conversations/sync/:agentId
//    → Syncs new conversations from ElevenLabs into the DB.
//      Returns how many new ones were saved.
//
//  GET  /api/conversations/:agentId
//    → Returns all cached conversations for an agent from DB.
//      Lightning fast — no ElevenLabs call.
//
//  GET  /api/conversations/:agentId/:conversationId
//    → Returns the full detail of a single conversation.
// ─────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const supabase = require('../utils/supabase');
const { asyncHandler, Errors } = require('../utils/errors');
const { requireSupabaseUser } = require('../middleware/auth');
const syncService  = require('../services/syncService');
const logger = require('../utils/logger');

// All conversation routes require an authenticated Supabase user
router.use(requireSupabaseUser);

// ── Helper: verify user has access to this agent ──────────────
async function getAgentForUser(agentDbId, user) {
  if (user.role === 'admin') {
    // Admins can access any agent
    const { data, error } = await supabase
      .from('agents')
      .select('id, name, agent_id, api_key, last_synced_at')
      .eq('id', agentDbId)
      .single();
    if (error || !data) throw Errors.notFound('Agent not found.');
    return data;
  } else {
    // Clients can only access agents assigned to them
    const { data, error } = await supabase
      .from('agent_access')
      .select('agents(id, name, agent_id, api_key, last_synced_at)')
      .eq('user_id', user.id)
      .eq('agent_id', agentDbId)  // agent_access.agent_id is the FK to agents.id
      .single();
    if (error || !data?.agents) throw Errors.forbidden('You do not have access to this agent.');
    return data.agents;
  }
}

// ──────────────────────────────────────────────────────────────
// POST /api/conversations/sync/:agentId
//
// Syncs new conversations from ElevenLabs for the given agent.
// Returns a summary: { newCount, totalCount, lastSyncedAt }
// ──────────────────────────────────────────────────────────────
router.post('/sync/:agentId', asyncHandler(async (req, res) => {
  const { agentId } = req.params;

  // Only admins can trigger syncs (clients just read cached data)
  if (req.user.role !== 'admin') {
    throw Errors.forbidden('Only admins can trigger conversation syncs.');
  }

  const agent = await getAgentForUser(agentId, req.user);

  if (!agent.api_key) {
    throw Errors.badRequest('This agent has no API key configured. Add one in the dashboard first.');
  }

  logger.info('Sync triggered', { agentId, agentName: agent.name, userId: req.user.id });

  const result = await syncService.syncConversations(
    agent.id,        // DB UUID
    agent.agent_id,  // ElevenLabs agent ID
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
// GET /api/conversations/:agentId
//
// Returns all stored conversations for an agent (from DB).
// Query params: limit, offset
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
//
// Returns the full detail of one stored conversation.
// ──────────────────────────────────────────────────────────────
router.get('/:agentId/:conversationId', asyncHandler(async (req, res) => {
  const { agentId, conversationId } = req.params;

  const agent = await getAgentForUser(agentId, req.user);

  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('agent_db_id', agent.id)
    .eq('conversation_id', conversationId)   // conversations.conversation_id = ElevenLabs ID
    .single();

  if (error || !data) {
    throw Errors.notFound(`Conversation ${conversationId} not found. Try syncing first.`);
  }

  res.json({ success: true, data });
}));

module.exports = router;