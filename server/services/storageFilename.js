'use strict';
function sanitizeFilename(name) {
  return name
    .replace(/[^a-zA-Z0-9.\-_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function contentDispositionAttachment(filename) {
  const rawName = String(filename || '').replace(/[\r\n]/g, ' ').trim();
  const safeName = rawName || 'download';
  const fallback = sanitizeFilename(safeName) || 'download';
  const escapedFallback = fallback.replace(/(["\\])/g, '\\$1');
  const encodedName = encodeURIComponent(safeName).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${escapedFallback}"; filename*=UTF-8''${encodedName}`;
}


module.exports = { sanitizeFilename, contentDispositionAttachment };
