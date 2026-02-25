// src/routes/agents.js
// ─────────────────────────────────────────────────────────────
//  Agent management endpoints:
//
//  GET  /api/agents          → list agents (role-aware)
//  GET  /api/agents/:id      → get single agent
//  POST /api/agents          → create agent (admin only)
//  PUT  /api/agents/:id      → update agent (admin only)
//  DELETE /api/agents/:id    → delete agent (admin only)
//  GET  /api/agents/:id/stats → quick stats (session count, last sync)
// ─────────────────────────────────────────────────────────────

const express  = require('express');
const router   = express.Router();
const supabase = require('../utils/supabase');
const { asyncHandler, Errors } = require('../utils/errors');
const { requireSupabaseUser, requireAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');

router.use(requireSupabaseUser);

// ── GET /api/agents ───────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  let agents;

  if (req.user.role === 'admin') {
    const { data, error } = await supabase
      .from('agents')
      .select('id, name, agent_id, emoji, color, created_at, last_synced_at')
      // Admins do NOT receive api_key in list view (security)
      .order('created_at');
    if (error) throw Errors.database('Failed to fetch agents.', { err: error.message });
    agents = data;
  } else {
    const { data, error } = await supabase
      .from('agent_access')
      .select('agents(id, name, agent_id, emoji, color, created_at, last_synced_at)')
      .eq('user_id', req.user.id);
    if (error) throw Errors.database('Failed to fetch assigned agents.', { err: error.message });
    agents = (data || []).map(r => r.agents).filter(Boolean);
  }

  res.json({ success: true, data: agents });
}));

// ── GET /api/agents/:id ───────────────────────────────────────
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const fields = req.user.role === 'admin'
    ? 'id, name, agent_id, emoji, color, created_at, last_synced_at'
    : 'id, name, agent_id, emoji, color, created_at, last_synced_at';
    // Note: api_key intentionally excluded from both — it's only used server-side

  const { data, error } = await supabase
    .from('agents')
    .select(fields)
    .eq('id', id)
    .single();

  if (error || !data) throw Errors.notFound('Agent not found.');

  // Non-admin: verify access
  if (req.user.role !== 'admin') {
    const { data: access } = await supabase
      .from('agent_access')
      .select('id')
      .eq('agent_id', id)
      .eq('user_id', req.user.id)
      .single();
    if (!access) throw Errors.forbidden('You do not have access to this agent.');
  }

  res.json({ success: true, data });
}));

// ── POST /api/agents ──────────────────────────────────────────
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { name, agent_id, api_key, emoji, color } = req.body;
  if (!name) throw Errors.badRequest('Agent name is required.');

  const { data, error } = await supabase
    .from('agents')
    .insert({ name, agent_id, api_key, emoji: emoji || '🤖', color: color || 'lav', created_by: req.user.id })
    .select('id, name, agent_id, emoji, color, created_at')
    .single();

  if (error) throw Errors.database('Failed to create agent.', { err: error.message });

  logger.info('Agent created', { agentId: data.id, name, userId: req.user.id });
  res.status(201).json({ success: true, data, message: 'Agent created successfully.' });
}));

// ── PUT /api/agents/:id ───────────────────────────────────────
router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, agent_id, api_key, emoji, color } = req.body;
  const updates = {};
  if (name     !== undefined) updates.name     = name;
  if (agent_id !== undefined) updates.agent_id = agent_id;
  if (api_key  !== undefined) updates.api_key  = api_key;
  if (emoji    !== undefined) updates.emoji    = emoji;
  if (color    !== undefined) updates.color    = color;

  if (!Object.keys(updates).length) throw Errors.badRequest('No fields to update.');

  const { data, error } = await supabase
    .from('agents')
    .update(updates)
    .eq('id', id)
    .select('id, name, agent_id, emoji, color, created_at, last_synced_at')
    .single();

  if (error) throw Errors.database('Failed to update agent.', { err: error.message });
  if (!data)  throw Errors.notFound('Agent not found.');

  logger.info('Agent updated', { agentId: id, updates: Object.keys(updates), userId: req.user.id });
  res.json({ success: true, data, message: 'Agent updated successfully.' });
}));

// ── DELETE /api/agents/:id ────────────────────────────────────
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Delete cascade handles agent_access and conversations rows automatically
  const { error } = await supabase.from('agents').delete().eq('id', id);
  if (error) throw Errors.database('Failed to delete agent.', { err: error.message });

  logger.info('Agent deleted', { agentId: id, userId: req.user.id });
  res.json({ success: true, message: 'Agent deleted successfully.' });
}));

// ── GET /api/agents/:id/stats ─────────────────────────────────
router.get('/:id/stats', asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Verify access
  if (req.user.role !== 'admin') {
    const { data: access } = await supabase
      .from('agent_access').select('id').eq('agent_id', id).eq('user_id', req.user.id).single();
    if (!access) throw Errors.forbidden('You do not have access to this agent.');
  }

  const { count: totalConvs } = await supabase
    .from('conversations')
    .select('*', { count: 'exact', head: true })
    .eq('agent_db_id', id);          // ← conversations uses agent_db_id

  const { data: agent } = await supabase
    .from('agents')
    .select('last_synced_at')
    .eq('id', id)
    .single();

  res.json({
    success: true,
    data: {
      agentId:      id,
      totalCached:  totalConvs || 0,
      lastSyncedAt: agent?.last_synced_at || null,
    },
  });
}));

module.exports = router;