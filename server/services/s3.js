'use strict';
// Compatibility facade: existing routes keep their keys, buckets, and authorization.
const { randomUUID } = require('crypto');
const { sanitizeFilename } = require('./storageFilename');
const { createDocumentStorage } = require('./documentStorage');
let storage;
function getStorage() { return storage || (storage = createDocumentStorage()); }
function buildKey({ firmId, ownerType, ownerId, year, docType, filename }) {
  const safe = sanitizeFilename(filename || 'file');
  const uuid = randomUUID();
  const yr = year || 'unknown';
  const dt = docType || 'other';
  const pilot = process.env.DOCUMENT_STORAGE_R2_PILOT === 'true' && safe.startsWith('R2-PILOT-');
  return `${firmId}/${ownerType}/${ownerId}/${yr}/${dt}/${pilot ? '__r2_pilot__/' : ''}${uuid}-${safe}`;
}


module.exports = {
  uploadFile: async args => { await require('./uploadSafety').inspectUpload(args); return getStorage().uploadFile(args); },
  downloadFile: args => getStorage().downloadFile(args),
  getSignedDownloadUrl: args => getStorage().getSignedDownloadUrl(args),
  deleteFile: args => getStorage().deleteFile(args),
  restoreVersion: args => getStorage().restoreVersion(args),
  buildKey, sanitizeFilename,
};
