'use strict';

const { Router } = require('express');
const crm = require('../services/agentCrm');

function createAgentWorkCrmRouter({ requireCapability, audit }) {
  const router = Router();

  function route(handler, eventType) {
    return async (req, res) => {
      try {
        const result = await handler(req);
        await audit(req, eventType, {
          relationship_id: result?.relationship_id || (req.params.relationshipId ? Number(req.params.relationshipId) : null),
          person_id: result?.id && req.path.includes('/people') ? result.id : (req.params.personId ? Number(req.params.personId) : null),
          company_id: result?.id && req.path.includes('/companies') ? result.id : (req.params.companyId ? Number(req.params.companyId) : null),
          count: Array.isArray(result) ? result.length : undefined,
        }).catch(() => {});
        res.status(req.method === 'POST' && !req.path.endsWith('/move-relationship') ? 201 : 200).json(result);
      } catch (error) {
        const status = error.statusCode || 500;
        if (status >= 500) console.error('[agent-work] CRM record error:', error);
        res.status(status).json({ error: status >= 500 ? 'CRM operation failed' : error.message });
      }
    };
  }

  const read = requireCapability('crm_read');
  const write = requireCapability('crm_write');

  router.get('/relationships', read, route(
    req => crm.listRelationships({ firmId: req.agentFirmId }),
    'crm_relationships_listed'
  ));
  router.get('/relationships/:relationshipId', read, route(
    req => crm.getRelationship({ firmId: req.agentFirmId, relationshipId: req.params.relationshipId }),
    'crm_relationship_read'
  ));
  router.get('/relationships/:relationshipId/snapshot', read, route(
    req => crm.getRelationshipSnapshot({ firmId: req.agentFirmId, relationshipId: req.params.relationshipId }),
    'crm_relationship_snapshot_read'
  ));
  router.post('/relationships', write, route(
    req => crm.createRelationship({ firmId: req.agentFirmId, input: req.body || {} }),
    'crm_relationship_created'
  ));
  router.put('/relationships/:relationshipId', write, route(
    req => crm.updateRelationship({ firmId: req.agentFirmId, relationshipId: req.params.relationshipId, input: req.body || {} }),
    'crm_relationship_updated'
  ));

  router.get('/people', read, route(
    req => crm.listPeople({ firmId: req.agentFirmId, relationshipId: req.query.relationship_id }),
    'crm_people_listed'
  ));
  router.get('/people/:personId', read, route(
    req => crm.getPerson({ firmId: req.agentFirmId, personId: req.params.personId }),
    'crm_person_read'
  ));
  router.post('/people', write, route(
    req => crm.createPerson({ firmId: req.agentFirmId, input: req.body || {} }),
    'crm_person_created'
  ));
  router.put('/people/:personId', write, route(
    req => crm.updatePerson({ firmId: req.agentFirmId, personId: req.params.personId, input: req.body || {} }),
    'crm_person_updated'
  ));
  router.post('/people/:personId/move-relationship', write, route(
    req => crm.movePerson({
      firmId: req.agentFirmId,
      personId: req.params.personId,
      relationshipId: req.body?.relationship_id,
      syncCompanyAccess: req.body?.sync_company_access !== false,
    }),
    'crm_person_moved'
  ));

  router.get('/companies/:companyId', read, route(
    req => crm.getCompany({ firmId: req.agentFirmId, staffUserId: req.agentStaffUserId, companyId: req.params.companyId }),
    'crm_company_read'
  ));
  router.post('/companies', write, route(
    req => crm.createCompany({ firmId: req.agentFirmId, input: req.body || {} }),
    'crm_company_created'
  ));
  router.put('/companies/:companyId', write, route(
    req => crm.updateCompany({ firmId: req.agentFirmId, staffUserId: req.agentStaffUserId, companyId: req.params.companyId, input: req.body || {} }),
    'crm_company_updated'
  ));
  router.post('/companies/:companyId/move-relationship', write, route(
    req => crm.moveCompany({
      firmId: req.agentFirmId,
      staffUserId: req.agentStaffUserId,
      companyId: req.params.companyId,
      relationshipId: req.body?.relationship_id,
      syncCompanyAccess: req.body?.sync_company_access !== false,
    }),
    'crm_company_moved'
  ));

  return router;
}

module.exports = { createAgentWorkCrmRouter };
