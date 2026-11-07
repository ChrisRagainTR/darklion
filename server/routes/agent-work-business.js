'use strict';

const { Router } = require('express');
const business = require('../services/agentBusinessRecords');

function createAgentWorkBusinessRouter({ requireCapability, audit = async () => {}, service = business } = {}) {
  if (typeof requireCapability !== 'function') throw new TypeError('requireCapability is required');
  const router = Router();

  function read(capability, eventType, handler) {
    return [requireCapability(capability), async (req, res) => {
      try {
        const result = await handler(req);
        await audit(req, eventType, {
          company_id: req.query.company_id ? Number(req.query.company_id) : undefined,
          person_id: req.params.personId ? Number(req.params.personId) : (req.query.person_id ? Number(req.query.person_id) : undefined),
          relationship_id: req.params.relationshipId ? Number(req.params.relationshipId) : undefined,
          delivery_id: req.params.deliveryId ? Number(req.params.deliveryId) : undefined,
          proposal_id: req.params.proposalId ? Number(req.params.proposalId) : undefined,
        }).catch(() => {});
        return res.json(result);
      } catch (error) {
        const known = error instanceof business.AgentBusinessError || error?.name === 'AgentBusinessError';
        const status = known ? (error.status || 400) : 500;
        if (!known) console.error('[agent-work-business] read failed:', error);
        return res.status(status).json({
          error: known ? error.message : 'Business record read failed',
          code: known ? error.code : 'business_record_read_failed',
        });
      }
    }];
  }

  router.get('/bookkeeping/overview', ...read('bookkeeping_read', 'bookkeeping_overview_read', req =>
    service.getBookkeepingOverview({ firmId: req.agentFirmId, staffUserId: req.agentStaffUserId })));
  router.get('/bookkeeping/runs', ...read('bookkeeping_read', 'bookkeeping_runs_listed', req =>
    service.listBookkeepingRuns({ firmId: req.agentFirmId, staffUserId: req.agentStaffUserId, limit: req.query.limit })));
  router.get('/bookkeeping/mappings', ...read('bookkeeping_read', 'bookkeeping_mappings_listed', req =>
    service.listBookkeepingMappings({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      realmId: req.query.realm_id,
      search: req.query.search,
      limit: req.query.limit,
    })));

  router.get('/tax-deliveries', ...read('tax_deliveries_read', 'tax_deliveries_listed', req =>
    service.listTaxDeliveries({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      companyId: req.query.company_id,
      personId: req.query.person_id,
      limit: req.query.limit,
    })));
  router.get('/tax-deliveries/:deliveryId/summary', ...read('tax_deliveries_read', 'tax_delivery_summary_read', req =>
    service.getTaxDeliverySummary({ firmId: req.agentFirmId, staffUserId: req.agentStaffUserId, deliveryId: req.params.deliveryId })));
  router.get('/tax-deliveries/:deliveryId', ...read('tax_deliveries_read', 'tax_delivery_read', req =>
    service.getTaxDelivery({ firmId: req.agentFirmId, staffUserId: req.agentStaffUserId, deliveryId: req.params.deliveryId })));

  router.get('/organizers/:personId/:year', ...read('organizers_read', 'organizer_read', req =>
    service.getOrganizer({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      personId: req.params.personId,
      year: req.params.year,
    })));
  router.get('/organizers/:personId', ...read('organizers_read', 'organizers_listed', req =>
    service.listOrganizers({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      personId: req.params.personId,
      limit: req.query.limit,
    })));

  router.get('/proposals/stats', ...read('proposals_read', 'proposal_stats_read', req =>
    service.getProposalStats({ firmId: req.agentFirmId, staffUserId: req.agentStaffUserId })));
  router.get('/proposals/:proposalId', ...read('proposals_read', 'proposal_read', req =>
    service.getProposal({ firmId: req.agentFirmId, staffUserId: req.agentStaffUserId, proposalId: req.params.proposalId })));
  router.get('/proposals', ...read('proposals_read', 'proposals_listed', req =>
    service.listProposals({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      status: req.query.status,
      limit: req.query.limit,
    })));

  router.get('/billing/relationships/:relationshipId/config', ...read('billing_read', 'billing_config_read', req =>
    service.getBillingConfig({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      relationshipId: req.params.relationshipId,
    })));
  router.get('/people/:personId/investments', ...read('investments_read', 'person_investments_read', req =>
    service.getPersonInvestments({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      personId: req.params.personId,
    })));
  router.get('/engagement-letters', ...read('engagements_read', 'engagement_letters_listed', req =>
    service.listEngagementLetters({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      limit: req.query.limit,
    })));

  return router;
}

module.exports = { createAgentWorkBusinessRouter };
