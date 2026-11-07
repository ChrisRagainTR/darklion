'use strict';

// Provider selection is process-wide and explicit. No silent cross-provider fallback.
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createHash, randomUUID } = require('crypto');
const sha = value => createHash('sha256').update(value).digest('hex');
const error = (code, status = 503) => Object.assign(new Error(code), { code, status });
const missing = e => e.$metadata?.httpStatusCode === 404 || e.name === 'NoSuchKey';
const metadataFields = ['ContentType', 'CacheControl', 'ContentDisposition', 'ContentEncoding', 'ContentLanguage'];
const headers = o => Object.fromEntries(metadataFields.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

function configuration(env) {
  const read = env.DOCUMENT_STORAGE_READ_PROVIDER || 'aws';
  const write = env.DOCUMENT_STORAGE_WRITE_PROVIDER || 'aws';
  if (![read, write].every(v => ['aws', 'r2'].includes(v))) throw error('INVALID_DOCUMENT_STORAGE_PROVIDER');
  const paused = env.DOCUMENT_STORAGE_WRITES_PAUSED === 'true';
  if (read !== write && !paused) throw error('MIXED_STORAGE_REQUIRES_PAUSED_WRITES');
  const logicalBucket = env.AWS_S3_BUCKET || env.S3_BUCKET || 'darklion-docs';
  if ([read, write].includes('r2') || env.DOCUMENT_STORAGE_R2_PILOT === 'true') {
    for (const key of ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_DOCUMENT_BUCKET', 'R2_HISTORY_BUCKET']) {
      if (!env[key]) throw error('MISSING_' + key);
    }
    const endpoint = new URL(env.R2_ENDPOINT);
    if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.r2.cloudflarestorage.com') ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
      throw error('INVALID_R2_ENDPOINT');
    }
    if (env.R2_DOCUMENT_BUCKET === env.R2_HISTORY_BUCKET) throw error('R2_HISTORY_MUST_BE_SEPARATE');
  }
  return { read, write, paused, logicalBucket };
}

async function bodyBuffer(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function createDocumentStorage({ env = process.env, clients = {}, sign = getSignedUrl } = {}) {
  const config = configuration(env);
  function client(provider) {
    if (!clients[provider]) clients[provider] = provider === 'aws'
      ? new S3Client({ region: env.AWS_REGION || 'us-east-1', credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      } })
      : new S3Client({ endpoint: env.R2_ENDPOINT, region: 'auto', credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      }, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
    return clients[provider];
  }
  function target(provider, bucket) {
    if (!bucket) throw error('DOCUMENT_BUCKET_REQUIRED', 400);
    if (provider === 'aws') return bucket;
    // Do not route unrelated archive or legacy buckets into the document bucket.
    if (bucket !== config.logicalBucket) throw error('UNMAPPED_DOCUMENT_BUCKET', 400);
    return env.R2_DOCUMENT_BUCKET;
  }
  function providerFor(operation, key) {
    if (String(key).split('/').includes('__r2_pilot__')) {
      if (env.DOCUMENT_STORAGE_R2_PILOT !== 'true') throw error('R2_PILOT_DISABLED');
      return 'r2';
    }
    return config[operation];
  }
  function writable() { if (config.paused) throw error('DOCUMENT_WRITES_PAUSED'); }
  function identity(bucket, key) { return sha(JSON.stringify([bucket, key])); }
  async function head(bucket, key) {
    try { return await client('r2').send(new HeadObjectCommand({ Bucket: bucket, Key: key })); }
    catch (e) { if (missing(e)) return null; throw e; }
  }
  async function archiveObject(key, body, meta = {}) {
    const c = client('r2'), Bucket = env.R2_HISTORY_BUCKET;
    const checksum = sha(body);
    try {
      await c.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: 'application/octet-stream',
        Metadata: { ...meta, sha256: checksum }, IfNoneMatch: '*' }));
    } catch (e) {
      if (e.$metadata?.httpStatusCode !== 412) throw e;
    }
    // A completed request or existing object is not enough: verify the bytes.
    const copy = await c.send(new GetObjectCommand({ Bucket, Key: key }));
    if (sha(await bodyBuffer(copy.Body)) !== checksum) throw error('DOCUMENT_HISTORY_CHECKSUM_MISMATCH');
  }
  async function event(prefix, name, data) {
    await archiveObject(prefix + '/' + name + '.json', Buffer.from(JSON.stringify(data)), { kind: name });
  }
  async function preservePrevious(Bucket, key, previous, prefix) {
    if (!previous) return;
    const r = await client('r2').send(new GetObjectCommand({ Bucket, Key: key, IfMatch: previous.ETag }));
    const bytes = await bodyBuffer(r.Body);
    await archiveObject(prefix + '/previous', bytes, { kind: 'previous' });
    await event(prefix, 'previous-metadata', { headers: headers(r), metadata: r.Metadata || {}, etag: r.ETag, sha256: sha(bytes) });
  }
  async function mutate({ bucket, key, buffer, mimeType, cacheControl, deletion = false }) {
    writable();
    const Bucket = target('r2', bucket), c = client('r2');
    const previous = await head(Bucket, key);
    if (deletion && (!previous || previous.Metadata?.['dl-deleted'] === 'true')) return;
    const operationId = randomUUID();
    const prefix = 'app/' + identity(bucket, key) + '/' + operationId;
    await preservePrevious(Bucket, key, previous, prefix);
    const bytes = deletion ? Buffer.alloc(0) : buffer;
    const currentHeaders = { ContentType: deletion ? 'application/x-darklion-deleted' : (mimeType || 'application/octet-stream'),
      ...(!deletion && cacheControl ? { CacheControl: cacheControl } : {}) };
    if (!deletion) await archiveObject(prefix + '/content', bytes, { kind: 'content' });
    const record = { schema: 1, operationId, bucket, key, action: deletion ? 'delete' : 'upload',
      sha256: sha(bytes), headers: currentHeaders, createdAt: new Date().toISOString(), previousETag: previous?.ETag || null };
    await event(prefix, 'intent', record);
    // Tombstones make deletion conditional, preserving newer concurrent writes.
    // A tombstone never receives a signed download link.
    await c.send(new PutObjectCommand({ Bucket, Key: key, Body: bytes, ...currentHeaders,
      Metadata: { 'dl-operation': operationId, 'dl-history': prefix, 'dl-sha256': sha(bytes),
        ...(deletion ? { 'dl-deleted': 'true' } : {}) },
      ...(previous ? { IfMatch: previous.ETag } : { IfNoneMatch: '*' }) }));
    // The current object's metadata is a durable commit pointer if receipt writing fails.
    let receiptPending = false;
    try { await event(prefix, 'committed', { ...record, committedAt: new Date().toISOString() }); }
    catch (_) { receiptPending = true; console.error('DOCUMENT_HISTORY_RECEIPT_PENDING', operationId); }
    return { key, bucket, versionId: operationId, historyPrefix: prefix, receiptPending };
  }
  async function uploadFile(args) {
    writable();
    if (providerFor('write', args.key) === 'r2') return mutate(args);
    await client('aws').send(new PutObjectCommand({ Bucket: target('aws', args.bucket), Key: args.key, Body: args.buffer,
      ContentType: args.mimeType || 'application/octet-stream', ...(args.cacheControl ? { CacheControl: args.cacheControl } : {}) }));
    return { key: args.key, bucket: args.bucket };
  }
  async function downloadFile({ bucket, key }) {
    const provider = providerFor('read', key);
    const r = await client(provider).send(new GetObjectCommand({ Bucket: target(provider, bucket), Key: key }));
    if (provider === 'r2' && r.Metadata?.['dl-deleted'] === 'true') { r.Body?.destroy?.(); throw error('DOCUMENT_NOT_FOUND', 404); }
    return bodyBuffer(r.Body);
  }
  async function getSignedDownloadUrl({ bucket, key, expiresIn = 900, filename, signingDate }) {
    const provider = providerFor('read', key), Bucket = target(provider, bucket);
    if (provider === 'r2') {
      const h = await head(Bucket, key);
      if (!h || h.Metadata?.['dl-deleted'] === 'true') throw error('DOCUMENT_NOT_FOUND', 404);
    }
    const { contentDispositionAttachment } = require('./storageFilename');
    return sign(client(provider), new GetObjectCommand({ Bucket, Key: key,
      ...(filename ? { ResponseContentDisposition: contentDispositionAttachment(filename) } : {}) }), { expiresIn, ...(signingDate ? { signingDate } : {}) });
  }
  async function deleteFile({ bucket, key }) {
    writable();
    if (providerFor('write', key) === 'r2') return mutate({ bucket, key, deletion: true });
    await client('aws').send(new DeleteObjectCommand({ Bucket: target('aws', bucket), Key: key }));
  }
  // Internal operator function. No unscoped HTTP endpoint is exposed.
  async function restoreVersion({ bucket, key, versionId }) {
    writable();
    if (providerFor('write', key) !== 'r2') throw error('RESTORE_REQUIRES_R2');
    if (!/^[0-9a-f-]{36}$/.test(versionId)) throw error('INVALID_STORAGE_VERSION', 400);
    const prefix = 'app/' + identity(bucket, key) + '/' + versionId;
    const c = client('r2'), Bucket = env.R2_HISTORY_BUCKET;
    const intent = JSON.parse((await bodyBuffer((await c.send(new GetObjectCommand({ Bucket, Key: prefix + '/intent.json' }))).Body)).toString());
    if (intent.bucket !== bucket || intent.key !== key || intent.action !== 'upload') throw error('INVALID_RESTORE_TARGET', 400);
    const bytes = await bodyBuffer((await c.send(new GetObjectCommand({ Bucket, Key: prefix + '/content' }))).Body);
    if (sha(bytes) !== intent.sha256) throw error('DOCUMENT_HISTORY_CHECKSUM_MISMATCH');
    return uploadFile({ bucket, key, buffer: bytes, mimeType: intent.headers.ContentType, cacheControl: intent.headers.CacheControl });
  }
  async function repairHistoryReceipt({ bucket, key }) {
    if (providerFor('write', key) !== 'r2') throw error('REPAIR_REQUIRES_R2');
    const current = await head(target('r2', bucket), key);
    const prefix = current?.Metadata?.['dl-history'];
    if (!prefix) return { repaired: false };
    const operationId = current.Metadata['dl-operation'];
    if (prefix !== 'app/' + identity(bucket, key) + '/' + operationId) throw error('INVALID_HISTORY_POINTER');
    const r = await client('r2').send(new GetObjectCommand({ Bucket: env.R2_HISTORY_BUCKET, Key: prefix + '/intent.json' }));
    const intent = JSON.parse((await bodyBuffer(r.Body)).toString());
    if (intent.bucket !== bucket || intent.key !== key || intent.operationId !== operationId ||
        intent.sha256 !== current.Metadata['dl-sha256']) throw error('INVALID_HISTORY_POINTER');
    // Repair is idempotent; never replace a receipt that was already persisted.
    try {
      const receipt = await client('r2').send(new GetObjectCommand({ Bucket: env.R2_HISTORY_BUCKET, Key: prefix + '/committed.json' }));
      const recorded = JSON.parse((await bodyBuffer(receipt.Body)).toString());
      if (recorded.operationId !== operationId) throw error('INVALID_HISTORY_POINTER');
      return { repaired: false, alreadyCommitted: true };
    } catch (e) { if (!missing(e)) throw e; }
    await event(prefix, 'committed', { ...intent, committedAt: new Date().toISOString(), repaired: true });
    return { repaired: true };
  }
  return { uploadFile, downloadFile, getSignedDownloadUrl, deleteFile, restoreVersion, repairHistoryReceipt, config };
}
module.exports = { createDocumentStorage, configuration };
