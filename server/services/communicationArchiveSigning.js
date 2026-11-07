'use strict';

const { sha256Hex, stableStringify } = require('./communicationArchiveCanonical');

async function signPayload(payload) {
  const message = Buffer.from(stableStringify(payload), 'utf8');
  return {
    algorithm: 'SHA256',
    key_id: null,
    signature_base64: sha256Hex(message),
    signed_payload: payload,
  };
}

function verifySignedPayload(proof) {
  const message = Buffer.from(stableStringify(proof.signed_payload), 'utf8');
  return proof.algorithm === 'SHA256' && proof.signature_base64 === sha256Hex(message);
}

module.exports = { signPayload, verifySignedPayload };
