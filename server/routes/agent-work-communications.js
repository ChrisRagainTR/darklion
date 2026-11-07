'use strict';

const { Router } = require('express');
const communications = require('../services/agentCommunications');
const { auditAgentEvent } = require('../services/agentConnections');

function capabilityEnabled(req, capability) {
  const capabilities = req.agentConnection?.capabilities || {};
  if (capabilities[capability] === true) return true;
  return capability === 'summaries_read'
    && capabilities.summaries_read !== false
    && capabilities.general_api === true;
}

function requireCapability(capability) {
  return (req, res, next) => capabilityEnabled(req, capability)
    ? next()
    : res.status(403).json({ error: `Agent capability disabled: ${capability}`, code: 'capability_disabled' });
}

function defaultAudit(req, eventType, metadata) {
  return auditAgentEvent({
    firmId: req.agentFirmId,
    staffUserId: req.agentStaffUserId,
    agentConnectionId: req.agentConnection?.id || null,
    eventType: `agent_work_${eventType}`,
    metadata: {
      ...(metadata || {}),
      api_token_id: req.agentApiTokenId || null,
      mcp_client_id: req.agentMcpClientId || null,
    },
  });
}

function createAgentWorkCommunicationsRouter({ service = communications, audit = defaultAudit, requireCapability: capabilityGuard = requireCapability } = {}) {
  const router = Router();
  const audited = (req, eventType, metadata) => audit(req, eventType, metadata).catch(() => {});
  const run = handler => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof communications.AgentCommunicationError || error?.name === 'AgentCommunicationError') {
        return res.status(error.status || 400).json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
      }
      console.error('[agent-work-communications] error:', error);
      return res.status(500).json({ error: 'Communication operation failed', code: 'communication_operation_failed' });
    }
  };

  router.get('/summaries', capabilityGuard('summaries_read'), run(async (req, res) => {
    const result = await service.listConversationSummaries({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      month: req.query.month,
    });
    await audited(req, 'conversation_summaries_listed', { month: result.month, count: result.summaries.length });
    return res.json(result);
  }));

  router.get('/summaries/:date', capabilityGuard('summaries_read'), run(async (req, res) => {
    const result = await service.getConversationSummary({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      date: req.params.date,
      markViewed: false,
    });
    await audited(req, 'conversation_summary_read', { date: result.date, thread_count: result.thread_count });
    return res.json(result);
  }));

  router.post('/client-messages', capabilityGuard('messages_send'), run(async (req, res) => {
    const result = await service.sendClientMessage({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      personId: req.body?.person_id,
      subject: req.body?.subject,
      body: req.body?.body,
      clientNonce: req.body?.client_nonce,
    });
    await audited(req, 'client_message_sent', {
      thread_id: result.thread_id,
      message_id: result.message_id,
      deduplicated: result.deduplicated,
      notification_sent: result.notification?.sent === true,
    });
    return res.status(result.deduplicated ? 200 : 201).json(result);
  }));

  router.post('/client-messages/:threadId/reply', capabilityGuard('messages_send'), run(async (req, res) => {
    const result = await service.replyToClientThread({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      threadId: req.params.threadId,
      body: req.body?.body,
      clientNonce: req.body?.client_nonce,
    });
    await audited(req, 'client_message_replied', {
      thread_id: result.thread_id,
      message_id: result.message_id,
      deduplicated: result.deduplicated,
      notification_sent: result.notification?.sent === true,
    });
    return res.status(result.deduplicated ? 200 : 201).json(result);
  }));

  return router;
}

module.exports = { capabilityEnabled, createAgentWorkCommunicationsRouter };
