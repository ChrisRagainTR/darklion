// tests/e2e/proposal-onboarding-regression.spec.js
// Regression coverage for signed proposal onboarding contracts.
// These tests intentionally inspect source-level route/UI invariants instead of
// mutating live proposal data. They protect idempotency and filing behavior that
// would otherwise require creating/signing real client proposals in dev/prod-like DBs.

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function collapseSql(source) {
  return source.replace(/\s+/g, ' ');
}

test.describe('Proposal onboarding regression contracts', () => {
  test('sending a proposal requires a CRM relationship before insert/update mutation', () => {
    const source = readRepoFile('server/routes/proposals.js');
    const createRouteStart = source.indexOf("router.post('/'");
    const detailRouteStart = source.indexOf('// GET /:id', createRouteStart);
    const updateRouteStart = source.indexOf("router.put('/:id([0-9]+)'", detailRouteStart);
    const deleteRouteStart = source.indexOf('// DELETE /:id', updateRouteStart);

    expect(createRouteStart).toBeGreaterThan(-1);
    expect(updateRouteStart).toBeGreaterThan(-1);

    const createRoute = source.slice(createRouteStart, detailRouteStart);
    const updateRoute = source.slice(updateRouteStart, deleteRouteStart);

    const createRelationshipGuardIndex = createRoute.indexOf("status === 'sent' && !relationship_id");
    const updateRelationshipGuardIndex = updateRoute.indexOf("status === 'sent' && !effectiveRelationshipId");

    for (const [route, relationshipGuardIndex] of [[createRoute, createRelationshipGuardIndex], [updateRoute, updateRelationshipGuardIndex]]) {
      const badRequestIndex = route.indexOf('res.status(400)', relationshipGuardIndex);
      const firstMutationIndex = route.indexOf(route === createRoute ? 'INSERT INTO proposals' : 'UPDATE proposals SET');

      expect(relationshipGuardIndex).toBeGreaterThan(-1);
      expect(badRequestIndex).toBeGreaterThan(relationshipGuardIndex);
      expect(route).toContain('A CRM relationship is required before sending a proposal.');
      expect(firstMutationIndex).toBeGreaterThan(badRequestIndex);
    }
  });

  test('public signing is idempotent: already-signed engagements return 409 before mutation', () => {
    const source = readRepoFile('server/routes/proposals-public.js');
    const signRouteStart = source.indexOf("router.post('/:token/sign'");
    expect(signRouteStart).toBeGreaterThan(-1);

    const signRouteEnd = source.indexOf('// GET /:token/pdf', signRouteStart);
    expect(signRouteEnd).toBeGreaterThan(signRouteStart);
    const signRoute = source.slice(signRouteStart, signRouteEnd);

    const duplicateGuardIndex = signRoute.indexOf("if (eng.status === 'signed')");
    const duplicateResponseIndex = signRoute.indexOf('res.status(409)', duplicateGuardIndex);
    const firstMutationIndex = signRoute.indexOf('UPDATE proposal_engagements');

    expect(duplicateGuardIndex).toBeGreaterThan(-1);
    expect(duplicateResponseIndex).toBeGreaterThan(duplicateGuardIndex);
    expect(signRoute).toContain("Already signed");
    expect(firstMutationIndex).toBeGreaterThan(duplicateResponseIndex);
  });

  test('signed proposal reset is rejected instead of deleting accepted engagement state', () => {
    const source = readRepoFile('server/routes/proposals-public.js');
    const resetRouteStart = source.indexOf("router.post('/:token/reset'");
    expect(resetRouteStart).toBeGreaterThan(-1);
    const resetRoute = source.slice(resetRouteStart);

    const signedGuardIndex = resetRoute.indexOf("prop[0].status === 'signed'");
    const conflictIndex = resetRoute.indexOf('res.status(409)', signedGuardIndex);
    const deleteAcceptanceIndex = resetRoute.indexOf('DELETE FROM proposal_acceptances');
    const deleteEngagementIndex = resetRoute.indexOf('DELETE FROM proposal_engagements');

    expect(signedGuardIndex).toBeGreaterThan(-1);
    expect(conflictIndex).toBeGreaterThan(signedGuardIndex);
    expect(resetRoute).toContain('Cannot reset a signed proposal');
    expect(deleteAcceptanceIndex).toBeGreaterThan(conflictIndex);
    expect(deleteEngagementIndex).toBeGreaterThan(conflictIndex);
  });

  test('save-to-CRM repairs signed proposals that are linked to a relationship', () => {
    const source = readRepoFile('server/routes/proposals.js');
    const routeStart = source.indexOf("router.post('/:id([0-9]+)/save-to-crm'");
    expect(routeStart).toBeGreaterThan(-1);
    const routeEnd = source.indexOf('// GET /stats', routeStart);
    expect(routeEnd).toBeGreaterThan(routeStart);
    const route = source.slice(routeStart, routeEnd);
    const compact = collapseSql(route);

    expect(compact).toContain("pe.status = 'signed'");
    expect(compact).not.toContain('pe.saved_to_crm = false');
    expect(route).toContain('Signed engagement not found');
    expect(route).toContain('if (!eng.relationship_id)');
    expect(route).toContain('No relationship linked to this proposal');
    expect(route).toContain('saveSignedProposalEngagementLetter');
    expect(route).toContain('ensurePortalAccessForSignedProposal');
    expect(route).toContain("fireTrigger(firmId, 'proposal_signed', eng.relationship_id, engagementContext, 'relationship')");
    expect(readRepoFile('server/services/proposalArtifacts.js')).toContain('UPDATE proposal_engagements SET saved_to_crm = true');
  });

  test('signed engagement filing creates active Engagement Letter and Delivered by Advisor document records', () => {
    const routeSource = readRepoFile('server/routes/proposals.js');
    const publicSource = readRepoFile('server/routes/proposals-public.js');
    const serviceSource = readRepoFile('server/services/proposalArtifacts.js');
    const compact = collapseSql(serviceSource);

    expect(routeSource).toContain('saveSignedProposalEngagementLetter');
    expect(publicSource).toContain('saveSignedProposalEngagementLetter');
    expect(serviceSource).toContain('CREATE TABLE IF NOT EXISTS engagement_letters');
    expect(compact).toContain('relationship_id INTEGER NOT NULL REFERENCES relationships(id)');
    expect(compact).toContain('INSERT INTO engagement_letters');
    expect(compact).toContain('INSERT INTO documents');
    expect(compact).toContain("'person'");
    expect(compact).toContain("'engagement_letter'");
    expect(compact).toContain("'firm_uploaded'");
    expect(compact).toContain('is_delivered, delivered_at');
    expect(compact).toContain('application/pdf');
    expect(serviceSource).toContain('signed_by_name');
    expect(serviceSource).toContain('signed_at');
    expect(serviceSource).toContain('signed2_by_name');
    expect(serviceSource).toContain('signed2_at');
  });

  test('post-sign automation files LOE before portal deployment and relationship onboarding', () => {
    const source = readRepoFile('server/routes/proposals-public.js');
    const helperStart = source.indexOf('async function runSignedProposalAutomation');
    const signRouteStart = source.indexOf("router.post('/:token/sign'");
    expect(helperStart).toBeGreaterThan(-1);
    expect(signRouteStart).toBeGreaterThan(-1);
    const helper = source.slice(helperStart, signRouteStart);
    const signRoute = source.slice(signRouteStart, source.indexOf('// GET /:token/pdf', signRouteStart));

    expect(signRoute).toContain('setImmediate');
    expect(helper).toContain('saveSignedProposalEngagementLetter');
    expect(helper).toContain('ensurePortalAccessForSignedProposal');
    expect(helper).toContain("fireTrigger(firmId, 'proposal_signed', relationshipId, context, 'relationship')");
    expect(helper).toContain("fireTrigger(row.firm_id, 'proposal_signed', row.person_id, context, 'person')");
    expect(helper.indexOf('saveSignedProposalEngagementLetter')).toBeLessThan(helper.indexOf('ensurePortalAccessForSignedProposal'));
    expect(helper.indexOf('ensurePortalAccessForSignedProposal')).toBeLessThan(helper.indexOf("fireTrigger(firmId, 'proposal_signed', relationshipId, context, 'relationship')"));
  });


  test('proposal primary person resolution never queries nonexistent proposal_engagements contact_phone', () => {
    const source = readRepoFile('server/services/portalAccess.js');
    const compact = collapseSql(source);

    expect(compact).not.toContain('pe.contact_phone');
    expect(compact).not.toContain('SELECT client_name, contact_name, contact_email, contact_phone FROM proposal_engagements');
    expect(compact).toContain('FROM proposal_acceptances');
    expect(compact).toContain('pa.contact_phone AS acceptance_contact_phone');
    expect(source).toContain('createPrimaryPersonForProposal');
    expect(source).toContain('createIfMissing');
  });

  test('pipeline trigger log records auto-created relationship onboarding jobs', () => {
    const source = readRepoFile('server/services/pipelineTriggers.js');
    const compact = collapseSql(source);

    expect(compact).toContain('Auto-created + placed: trigger');
    expect(compact).toContain('INSERT INTO pipeline_trigger_log');
    expect(compact).toContain('created: true');
    expect(compact).toContain('entityType, entityId');
  });

  test('relationship snapshot surfaces active Engagement Letters instead of relying on generic document categories', () => {
    const source = readRepoFile('server/routes/relationships.js');
    const compact = collapseSql(source);

    expect(compact).toContain('FROM engagement_letters');
    expect(compact).toContain("WHERE firm_id = $1 AND relationship_id = $2 AND status = 'active'");
    expect(compact).toContain('active_engagements');
  });

  test('proposal detail UI exposes save-to-CRM only for signed linked unsaved engagements and blocks signed edits', () => {
    const source = readRepoFile('server/views/proposal-detail.ejs');
    const compact = collapseSql(source);

    expect(compact).toContain("p.status === 'signed' && p.relationship_id && eng && !eng.saved_to_crm");
    expect(source).toContain('Save to CRM');
    expect(source).toContain("p.status !== 'signed'");
    expect(source).toContain('Signed — cannot edit');
  });

  test('agent proposal tool creates complete proposals and returns current public link path', () => {
    const source = readRepoFile('server/routes/emma-chat.js');
    const defaults = readRepoFile('server/services/proposalDefaults.js');
    const toolStart = source.indexOf("case 'create_proposal'");
    const toolEnd = source.indexOf('// ── create_pipeline_job', toolStart);
    expect(toolStart).toBeGreaterThan(-1);
    expect(toolEnd).toBeGreaterThan(toolStart);
    const route = source.slice(toolStart, toolEnd);
    const compact = collapseSql(route);

    expect(source).toContain("const { normalizeProposalTiers } = require('../services/proposalDefaults')");
    expect(defaults).toContain('WEALTH_DEFAULT_TIERS');
    expect(defaults).toContain('TAX_DEFAULT_TIERS');
    expect(route).toContain('normalizeProposalTiers');
    expect(route).toContain("input.status === 'sent' ? 'sent' : 'draft'");
    expect(compact).toContain('client_phone, client_address, client_city_state_zip, engagement_type, tiers, add_ons');
    expect(compact).toContain('JSON.stringify(tiers)');
    expect(compact).toContain('JSON.stringify(addOns)');
    expect(compact).toContain('JSON.stringify(backwork)');
    expect(route).toContain('getPrimaryProposalDomain');
    expect(route).toContain('/p/${publicToken}');
    expect(route).not.toContain('/proposal/${publicToken}');
  });

  test('agent sent proposals reuse the staff proposal_sent person pipeline fan-out', () => {
    const emmaSource = readRepoFile('server/routes/emma-chat.js');
    const proposalsSource = readRepoFile('server/routes/proposals.js');
    const triggerSource = readRepoFile('server/services/proposalTriggers.js');
    const toolStart = emmaSource.indexOf("case 'create_proposal'");
    const toolEnd = emmaSource.indexOf('// ── create_pipeline_job', toolStart);
    expect(toolStart).toBeGreaterThan(-1);
    expect(toolEnd).toBeGreaterThan(toolStart);
    const route = emmaSource.slice(toolStart, toolEnd);
    const compactTrigger = collapseSql(triggerSource);

    expect(emmaSource).toContain("const { fireProposalPersonTrigger } = require('../services/proposalTriggers')");
    expect(proposalsSource).toContain("const { fireProposalPersonTrigger } = require('../services/proposalTriggers')");
    expect(route).toContain("fireProposalPersonTrigger(firmId, 'proposal_sent', rows[0].id");
    expect(route).not.toContain("fireTrigger(firmId, 'proposal_sent', rel.id");
    expect(compactTrigger).toContain('FROM proposals pr JOIN relationships r ON r.id = pr.relationship_id JOIN people p ON');
    expect(compactTrigger).toContain("fireTrigger(firmId, triggerKey, row.person_id, { proposal_id: proposalId, ...context }, 'person')");
  });
});
