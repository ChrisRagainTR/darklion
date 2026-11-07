'use strict';

const { pool } = require('../db');
const { fireTrigger } = require('./pipelineTriggers');

// Fire proposal-related person pipeline triggers for every person tied to the proposal's relationship.
async function fireProposalPersonTrigger(firmId, triggerKey, proposalId, context = {}) {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT p.id AS person_id
       FROM proposals pr
       JOIN relationships r ON r.id = pr.relationship_id
       JOIN people p ON (p.relationship_id = r.id OR
         p.id IN (SELECT person_id FROM person_company_access pca
                  JOIN companies c ON c.id = pca.company_id
                  WHERE c.relationship_id = r.id))
       WHERE pr.id = $1 AND pr.firm_id = $2`,
      [proposalId, firmId]
    );
    for (const row of rows) {
      fireTrigger(firmId, triggerKey, row.person_id, { proposal_id: proposalId, ...context }, 'person')
        .catch(e => console.error(`[proposalTriggers] fireTrigger ${triggerKey} non-fatal:`, e));
    }
  } catch (e) {
    console.error('[proposalTriggers] fireProposalPersonTrigger non-fatal:', e);
  }
}

module.exports = { fireProposalPersonTrigger };
