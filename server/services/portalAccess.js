'use strict';

const crypto = require('crypto');
const { pool } = require('../db');
const { sendPortalInvite } = require('./email');
const { auditLog } = require('./audit');

const PORTAL_URL = (process.env.PORTAL_URL || process.env.APP_URL || 'http://localhost:8080').replace(/\/+$/, '');
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function fullName(person) {
  return `${person.first_name || ''} ${person.last_name || ''}`.trim();
}

function inviteUrl(token, slug) {
  return `${PORTAL_URL}/client-login${slug ? `/${encodeURIComponent(slug)}` : ''}?invite=${token}`;
}

function isUnexpired(expiresAt) {
  return expiresAt && new Date(expiresAt) > new Date();
}

async function linkRelationshipCompanyAccess(personId, relationshipId, firmId) {
  if (!personId || !relationshipId || !firmId) return 0;
  const { rowCount } = await pool.query(`
    INSERT INTO person_company_access (person_id, company_id, access_level)
    SELECT $1, c.id, 'full'
    FROM companies c
    WHERE c.relationship_id = $2 AND c.firm_id = $3
    ON CONFLICT (person_id, company_id) DO NOTHING
  `, [personId, relationshipId, firmId]);
  return rowCount || 0;
}

async function loadPersonForInvite(personId, firmId) {
  const { rows } = await pool.query(
    `SELECT p.*, f.name AS firm_name, f.slug AS firm_slug
     FROM people p
     JOIN firms f ON f.id = p.firm_id
     WHERE p.id = $1 AND p.firm_id = $2`,
    [personId, firmId]
  );
  return rows[0] || null;
}

async function sendPortalInviteForPerson({ personId, firmId, spouse = false, ip = null, sendEmail = true, reusePending = false }) {
  const person = await loadPersonForInvite(personId, firmId);
  if (!person) {
    const err = new Error('Person not found');
    err.statusCode = 404;
    throw err;
  }

  const targetEmail = spouse ? person.spouse_email : person.email;
  const targetName = spouse ? (person.spouse_name || 'Spouse') : fullName(person);
  if (!targetEmail) {
    const err = new Error(spouse ? 'Person has no spouse email address' : 'Person has no email address');
    err.statusCode = 400;
    throw err;
  }

  const existingToken = spouse ? person.spouse_portal_invite_token : person.portal_invite_token;
  const existingExpires = spouse ? person.spouse_portal_invite_expires_at : person.portal_invite_expires_at;
  const hasPassword = spouse ? !!person.spouse_portal_password_hash : !!person.portal_password_hash;
  const enabled = spouse ? !!person.spouse_portal_enabled : !!person.portal_enabled;

  // An invite is only for a client who has not established portal credentials.
  // Re-inviting an active client must never disable their existing login or leave
  // an invite token that makes the CRM show the account as pending.
  if (enabled && hasPassword) {
    return {
      ok: true,
      status: 'active',
      personId: person.id,
      email: targetEmail,
      inviteUrl: null,
      inviteExpiresAt: null,
      emailSent: false,
      reused: true,
      spouse: !!spouse,
    };
  }

  if (reusePending && existingToken && isUnexpired(existingExpires) && !(enabled && hasPassword)) {
    return {
      ok: true,
      status: 'invite_pending',
      personId: person.id,
      email: targetEmail,
      inviteUrl: inviteUrl(existingToken, person.firm_slug),
      inviteExpiresAt: existingExpires,
      emailSent: false,
      reused: true,
      spouse: !!spouse,
    };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  if (spouse) {
    await pool.query(
      `UPDATE people SET
         spouse_portal_invite_token = $1,
         spouse_portal_invite_expires_at = $2
       WHERE id = $3`,
      [token, expiresAt, person.id]
    );
    await auditLog(firmId, 'portal_invite_sent', `Spouse portal invite sent to ${targetEmail}`, ip);
  } else {
    await pool.query(
      `UPDATE people SET
         portal_invite_token = $1,
         portal_invite_expires_at = $2,
         portal_enabled = false
       WHERE id = $3`,
      [token, expiresAt, person.id]
    );
    await auditLog(firmId, 'portal_invite_sent', `Portal invite sent to ${targetEmail}`, ip);
  }

  const url = inviteUrl(token, person.firm_slug);
  let emailSent = false;
  let emailError = null;

  if (sendEmail) {
    try {
      await sendPortalInvite({
        to: targetEmail,
        name: targetName,
        firmName: person.firm_name,
        firmId: person.firm_id,
        inviteUrl: url,
      });
      emailSent = true;
    } catch (err) {
      emailError = err.message;
      console.error(`${spouse ? 'Spouse p' : 'P'}ortal invite email failed (non-fatal):`, err.message);
    }
  }

  return {
    ok: true,
    status: 'invite_sent',
    personId: person.id,
    email: targetEmail,
    inviteUrl: url,
    inviteExpiresAt: expiresAt,
    emailSent,
    emailError,
    reused: false,
    spouse: !!spouse,
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function splitClientName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: 'Client', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

async function createPrimaryPersonForProposal(proposal) {
  const email = String(proposal.client_email || proposal.engagement_contact_email || '').trim();
  if (!email) return null;
  const { firstName, lastName } = splitClientName(proposal.client_name || proposal.engagement_client_name || proposal.engagement_contact_name || 'Client');
  const { rows } = await pool.query(
    `INSERT INTO people (firm_id, relationship_id, first_name, last_name, email, phone, portal_enabled, notes, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, false, $7, NOW(), NOW())
     RETURNING *`,
    [
      proposal.firm_id,
      proposal.relationship_id,
      firstName,
      lastName,
      email,
      proposal.acceptance_contact_phone || proposal.client_phone || '',
      `Created automatically from signed proposal #${proposal.proposal_id}`,
    ]
  );
  return rows[0] || null;
}

function summarizePersonPortal(person) {
  if (!person) return { status: 'no_person' };
  if (person.portal_enabled && person.portal_password_hash) return { status: 'active' };
  if (person.portal_invite_token && isUnexpired(person.portal_invite_expires_at)) {
    return {
      status: 'invite_pending',
      inviteUrl: inviteUrl(person.portal_invite_token),
      inviteExpiresAt: person.portal_invite_expires_at,
    };
  }
  if (person.portal_invite_token) return { status: 'invite_expired', inviteExpiresAt: person.portal_invite_expires_at };
  if (person.portal_password_hash && !person.portal_enabled) return { status: 'disabled_with_password' };
  return { status: 'not_deployed' };
}

async function resolveProposalPrimaryPerson(proposalId, firmId, { createIfMissing = false } = {}) {
  const { rows } = await pool.query(
    `SELECT p.id AS proposal_id, p.firm_id, p.relationship_id, p.client_name, p.client_email, p.client_phone,
            pe.client_name AS engagement_client_name,
            pe.contact_name AS engagement_contact_name,
            pe.contact_email AS engagement_contact_email,
            pa.contact_phone AS acceptance_contact_phone
     FROM proposals p
     LEFT JOIN LATERAL (
       SELECT client_name, contact_name, contact_email
       FROM proposal_engagements
       WHERE proposal_id = p.id
       ORDER BY created_at DESC
       LIMIT 1
     ) pe ON true
     LEFT JOIN LATERAL (
       SELECT contact_phone
       FROM proposal_acceptances
       WHERE proposal_id = p.id
       ORDER BY created_at DESC
       LIMIT 1
     ) pa ON true
     WHERE p.id = $1 AND p.firm_id = $2`,
    [proposalId, firmId]
  );
  const proposal = rows[0];
  if (!proposal) return { ok: false, status: 'proposal_not_found', reason: 'Proposal not found' };
  if (!proposal.relationship_id) return { ok: false, status: 'no_relationship', reason: 'Proposal is not linked to a relationship' };

  const { rows: people } = await pool.query(
    `SELECT * FROM people
     WHERE firm_id = $1 AND relationship_id = $2
     ORDER BY id ASC`,
    [firmId, proposal.relationship_id]
  );
  if (!people.length) {
    if (createIfMissing) {
      const created = await createPrimaryPersonForProposal(proposal);
      if (created) return { ok: true, person: created, proposal, createdPerson: true };
    }
    return { ok: false, status: 'no_person', reason: 'No people found for linked relationship' };
  }

  const emails = [proposal.client_email, proposal.engagement_contact_email].map(normalizeEmail).filter(Boolean);
  let person = null;
  for (const email of emails) {
    const matches = people.filter(p => normalizeEmail(p.email) === email);
    if (matches.length === 1) {
      person = matches[0];
      break;
    }
    if (matches.length > 1) {
      return { ok: false, status: 'ambiguous_person', reason: `Multiple people match ${email}`, proposal };
    }
  }

  if (!person && people.length === 1) person = people[0];
  if (!person) {
    return {
      ok: false,
      status: 'ambiguous_person',
      reason: 'Could not uniquely resolve primary person from proposal email/contact email',
      proposal,
    };
  }
  if (!person.email) return { ok: false, status: 'missing_email', reason: 'Primary person has no email address', person, proposal };

  return { ok: true, person, proposal };
}

async function ensurePortalAccessForSignedProposal(proposalId, firmId, { ip = null, sendEmail = true } = {}) {
  const resolved = await resolveProposalPrimaryPerson(proposalId, firmId);
  if (!resolved.ok) return { ok: false, ...resolved };

  const { person, proposal } = resolved;
  const linkedCompanies = await linkRelationshipCompanyAccess(person.id, proposal.relationship_id, firmId);

  if (person.portal_enabled && person.portal_password_hash) {
    return {
      ok: true,
      status: 'active',
      personId: person.id,
      email: person.email,
      linkedCompanies,
      inviteUrl: null,
      emailSent: false,
      reused: true,
      reason: 'Portal already active',
    };
  }

  if (person.portal_password_hash && !person.portal_enabled) {
    await pool.query(
      `UPDATE people SET portal_enabled = true, portal_invite_token = NULL, portal_invite_expires_at = NULL WHERE id = $1 AND firm_id = $2`,
      [person.id, firmId]
    );
    await auditLog(firmId, 'portal_reactivated', `Portal reactivated for ${person.email} after signed proposal`, ip);
    return {
      ok: true,
      status: 'reactivated',
      personId: person.id,
      email: person.email,
      linkedCompanies,
      inviteUrl: null,
      emailSent: false,
      reused: true,
    };
  }

  const invite = await sendPortalInviteForPerson({
    personId: person.id,
    firmId,
    spouse: false,
    ip,
    sendEmail,
    reusePending: true,
  });

  return {
    ...invite,
    linkedCompanies,
  };
}

async function getProposalPortalDeploymentStatus(proposalId, firmId) {
  const resolved = await resolveProposalPrimaryPerson(proposalId, firmId);
  if (!resolved.ok) return { ok: false, status: resolved.status, reason: resolved.reason };

  const { person, proposal } = resolved;
  const portal = summarizePersonPortal(person);
  return {
    ok: true,
    ...portal,
    personId: person.id,
    email: person.email,
    relationshipId: proposal.relationship_id,
  };
}

module.exports = {
  sendPortalInviteForPerson,
  ensurePortalAccessForSignedProposal,
  getProposalPortalDeploymentStatus,
  resolveProposalPrimaryPerson,
  linkRelationshipCompanyAccess,
  createPrimaryPersonForProposal,
};
