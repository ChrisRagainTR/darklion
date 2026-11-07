'use strict';

const { Router } = require('express');
const agentDocuments = require('../services/agentDocuments');
const { auditAgentEvent } = require('../services/agentConnections');

function capabilityEnabled(req, capability) {
  const capabilities = req.agentConnection?.capabilities || {};
  if (capabilities[capability] === true) return true;
  return capability === 'documents_read'
    && capabilities.documents_read !== false
    && capabilities.general_api === true;
}

function requireCapability(capability) {
  return (req, res, next) => {
    if (capabilityEnabled(req, capability)) return next();
    return res.status(403).json({ error: `Agent capability disabled: ${capability}`, code: 'capability_disabled' });
  };
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

function booleanQuery(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

function createAgentWorkDocumentsRouter({ service = agentDocuments, audit = defaultAudit, requireCapability: capabilityGuard = requireCapability } = {}) {
  const router = Router();
  const audited = (req, eventType, metadata) => audit(req, eventType, metadata).catch(() => {});
  const run = handler => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof agentDocuments.AgentDocumentError || error?.name === 'AgentDocumentError') {
        return res.status(error.status || 400).json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
      }
      console.error('[agent-work-documents] error:', error);
      return res.status(500).json({ error: 'Document operation failed', code: 'document_operation_failed' });
    }
  };

  router.get('/', capabilityGuard('documents_read'), run(async (req, res) => {
    const result = await service.listDocuments({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      filters: {
        owner_type: req.query.owner_type,
        owner_id: req.query.owner_id,
        relationship_id: req.query.relationship_id,
        year: req.query.year,
        doc_type: req.query.doc_type,
        folder_section: req.query.folder_section,
        folder_category: req.query.folder_category,
        is_delivered: req.query.is_delivered,
        deleted: req.query.deleted,
        limit: req.query.limit,
        offset: req.query.offset,
      },
    });
    await audited(req, 'documents_listed', { count: result.documents.length, deleted: req.query.deleted || 'active' });
    return res.json(result);
  }));

  router.get('/folders', capabilityGuard('documents_read'), run(async (req, res) => {
    const result = await service.listDocumentFolders({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      ownerType: String(req.query.owner_type || ''),
      ownerId: req.query.owner_id,
    });
    await audited(req, 'document_folders_listed', { count: result.folders.length });
    return res.json(result);
  }));

  router.post('/folders', capabilityGuard('documents_write'), run(async (req, res) => {
    const folder = await service.createClientDocumentFolder({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      input: req.body || {},
    });
    await audited(req, 'document_folder_created', { folder_id: folder.id, owner_type: folder.owner_type, owner_id: folder.owner_id });
    return res.status(201).json({ folder });
  }));

  router.get('/:documentId', capabilityGuard('documents_read'), run(async (req, res) => {
    const document = await service.getDocument({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      documentId: req.params.documentId,
      includeDeleted: booleanQuery(req.query.include_deleted),
    });
    await audited(req, 'document_viewed', { document_id: document.id, included_deleted: booleanQuery(req.query.include_deleted) });
    return res.json({ document });
  }));

  router.get('/:documentId/extracted-data', capabilityGuard('documents_read'), run(async (req, res) => {
    const result = await service.getExtractedDocumentData({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      documentId: req.params.documentId,
      live: booleanQuery(req.query.live),
    });
    await audited(req, 'document_extracted_data_read', { document_id: result.document_id, source: result.source, live: booleanQuery(req.query.live) });
    return res.json(result);
  }));

  router.get('/:documentId/download-url', capabilityGuard('documents_read'), run(async (req, res) => {
    const result = await service.getDocumentDownloadUrl({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      documentId: req.params.documentId,
    });
    await audited(req, 'document_download_url_created', { document_id: result.document_id, expires_in_seconds: result.expires_in_seconds });
    return res.json(result);
  }));

  router.put('/:documentId', capabilityGuard('documents_write'), run(async (req, res) => {
    const document = await service.updateDocument({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      documentId: req.params.documentId,
      input: req.body || {},
    });
    await audited(req, 'document_updated', { document_id: document.id });
    return res.json({ document });
  }));

  router.delete('/:documentId', capabilityGuard('documents_write'), run(async (req, res) => {
    const result = await service.trashDocument({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      documentId: req.params.documentId,
      reason: req.body?.reason,
    });
    await audited(req, 'document_trashed', { document_id: result.document_id });
    return res.json(result);
  }));

  router.post('/:documentId/restore', capabilityGuard('documents_write'), run(async (req, res) => {
    const document = await service.restoreDocument({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      documentId: req.params.documentId,
    });
    await audited(req, 'document_restored', { document_id: document.id });
    return res.json({ document });
  }));

  return router;
}

module.exports = { capabilityEnabled, createAgentWorkDocumentsRouter };
