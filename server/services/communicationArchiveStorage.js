'use strict';

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  GetObjectRetentionCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { retainUntilDate, sha256Hex } = require('./communicationArchiveCanonical');

function archiveConfigured() {
  return !!(process.env.COMMUNICATION_ARCHIVE_BUCKET || process.env.COMPLIANCE_ARCHIVE_BUCKET);
}

function archiveBucket() {
  return process.env.COMMUNICATION_ARCHIVE_BUCKET || process.env.COMPLIANCE_ARCHIVE_BUCKET || '';
}

function archiveRegion() {
  return process.env.COMMUNICATION_ARCHIVE_REGION || process.env.AWS_REGION || 'us-east-2';
}

function r2Archive() {
  const provider = process.env.COMMUNICATION_ARCHIVE_STORAGE_PROVIDER || 'aws';
  if (provider === 'aws') return null;
  if (provider !== 'r2') throw new Error('INVALID_ARCHIVE_STORAGE_PROVIDER');
  return require('./communicationArchiveR2').createR2Archive({ env: process.env });
}

function objectLockEnabled() {
  return process.env.COMMUNICATION_ARCHIVE_OBJECT_LOCK_ENABLED === 'true';
}

function getClient() {
  if ((process.env.COMMUNICATION_ARCHIVE_STORAGE_PROVIDER || 'aws') !== 'aws') {
    throw Object.assign(new Error('INVALID_ARCHIVE_STORAGE_PROVIDER'), { code: 'INVALID_ARCHIVE_STORAGE_PROVIDER' });
  }
  const dedicated = ['COMMUNICATION_ARCHIVE_ACCESS_KEY_ID', 'COMMUNICATION_ARCHIVE_SECRET_ACCESS_KEY', 'COMMUNICATION_ARCHIVE_SESSION_TOKEN']
    .some(name => process.env[name]);
  if (dedicated && (!process.env.COMMUNICATION_ARCHIVE_ACCESS_KEY_ID || !process.env.COMMUNICATION_ARCHIVE_SECRET_ACCESS_KEY)) {
    throw Object.assign(new Error('ARCHIVE_CREDENTIALS_INCOMPLETE'), { code: 'ARCHIVE_CREDENTIALS_INCOMPLETE' });
  }
  return new S3Client({
    region: archiveRegion(),
    credentials: dedicated ? {
      accessKeyId: process.env.COMMUNICATION_ARCHIVE_ACCESS_KEY_ID,
      secretAccessKey: process.env.COMMUNICATION_ARCHIVE_SECRET_ACCESS_KEY,
      ...(process.env.COMMUNICATION_ARCHIVE_SESSION_TOKEN ? { sessionToken: process.env.COMMUNICATION_ARCHIVE_SESSION_TOKEN } : {}),
    } : process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
    } : undefined,
  });
}

function expectedBucketOwner() {
  const owner = process.env.COMMUNICATION_ARCHIVE_EXPECTED_BUCKET_OWNER;
  if (owner && !/^\d{12}$/.test(owner)) throw new Error('INVALID_ARCHIVE_BUCKET_OWNER');
  return owner ? { ExpectedBucketOwner: owner } : {};
}

async function streamToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

async function putImmutableObject({ key, body, contentType = 'application/json', metadata = {} }) {
  if (process.env.COMMUNICATION_ARCHIVE_WRITES_PAUSED === 'true') {
    throw Object.assign(new Error('Archive writes are paused for migration.'), { code: 'ARCHIVE_WRITES_PAUSED', statusCode: 503 });
  }
  const r2 = r2Archive();
  if (r2) return r2.putImmutableObject({ key, body, contentType, metadata });
  if (!archiveConfigured()) {
    const err = new Error('COMMUNICATION_ARCHIVE_BUCKET is not configured.');
    err.code = 'ARCHIVE_NOT_CONFIGURED';
    err.statusCode = 503;
    throw err;
  }
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const checksum = sha256Hex(buffer);
  const retainUntil = retainUntilDate();
  const useObjectLock = objectLockEnabled();
  const client = getClient();
  const command = new PutObjectCommand({
    Bucket: archiveBucket(),
    ...expectedBucketOwner(),
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ChecksumAlgorithm: 'SHA256',
    Metadata: {
      ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)])),
      content_sha256: checksum,
    },
    ...(useObjectLock ? {
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: retainUntil,
    } : {}),
    IfNoneMatch: '*',
  });
  try {
    const result = await client.send(command);
    return {
      bucket: archiveBucket(),
      key,
      versionId: result.VersionId || null,
      etag: result.ETag || null,
      checksumSha256: checksum,
      retainUntilDate: useObjectLock ? retainUntil.toISOString() : null,
      objectLockMode: useObjectLock ? 'COMPLIANCE' : null,
    };
  } catch (error) {
    // Idempotent write: if object already exists with same checksum, treat as success.
    if (String(error.name || error.Code || '').includes('Precondition') || error.$metadata?.httpStatusCode === 412) {
      const head = await client.send(new HeadObjectCommand({ Bucket: archiveBucket(), Key: key, ...expectedBucketOwner() }));
      const existingChecksum = head.Metadata?.content_sha256 || '';
      if (existingChecksum && existingChecksum !== checksum) {
        const err = new Error('Archive object already exists with a different checksum.');
        err.code = 'ARCHIVE_CHECKSUM_CONFLICT';
        err.statusCode = 409;
        throw err;
      }
      let retention = null;
      if (useObjectLock) {
        try {
          const ret = await client.send(new GetObjectRetentionCommand({ Bucket: archiveBucket(), Key: key, VersionId: head.VersionId, ...expectedBucketOwner() }));
          retention = ret.Retention || null;
        } catch (_) {}
      }
      return {
        bucket: archiveBucket(),
        key,
        versionId: head.VersionId || null,
        etag: head.ETag || null,
        checksumSha256: existingChecksum || checksum,
        retainUntilDate: retention?.RetainUntilDate ? new Date(retention.RetainUntilDate).toISOString() : null,
        objectLockMode: retention?.Mode || null,
        alreadyExisted: true,
      };
    }
    throw error;
  }
}

async function getImmutableObject({ key, versionId = null }) {
  const r2 = r2Archive();
  if (r2) return r2.getImmutableObject({ key, versionId });
  const client = getClient();
  const result = await client.send(new GetObjectCommand({
    Bucket: archiveBucket(),
    ...expectedBucketOwner(),
    Key: key,
    ...(versionId ? { VersionId: versionId } : {}),
  }));
  const buffer = await streamToBuffer(result.Body);
  return {
    bucket: archiveBucket(),
    key,
    versionId: result.VersionId || versionId,
    contentType: result.ContentType || 'application/octet-stream',
    body: buffer,
    checksumSha256: result.Metadata?.content_sha256 || sha256Hex(buffer),
  };
}

async function getSignedArchiveDownloadUrl({ key, versionId = null, filename = null, expiresIn = 900 }) {
  const r2 = r2Archive();
  if (r2) return r2.getSignedArchiveDownloadUrl({ key, versionId, filename, expiresIn });
  const client = getClient();
  const command = new GetObjectCommand({
    Bucket: archiveBucket(),
    ...expectedBucketOwner(),
    Key: key,
    ...(versionId ? { VersionId: versionId } : {}),
    ...(filename ? { ResponseContentDisposition: `attachment; filename="${String(filename).replace(/"/g, '')}"` } : {}),
  });
  return getSignedUrl(client, command, { expiresIn });
}

function localDevFallbackEnabled() {
  return process.env.COMMUNICATION_ARCHIVE_ALLOW_LOCAL_FALLBACK === 'true' && process.env.NODE_ENV !== 'production';
}

async function putImmutableObjectWithOptionalLocalFallback(args) {
  if (archiveConfigured()) return putImmutableObject(args);
  if (!localDevFallbackEnabled()) {
    const err = new Error('COMMUNICATION_ARCHIVE_BUCKET is not configured.');
    err.code = 'ARCHIVE_NOT_CONFIGURED';
    err.statusCode = 503;
    throw err;
  }
  const buffer = Buffer.isBuffer(args.body) ? args.body : Buffer.from(String(args.body), 'utf8');
  const checksum = sha256Hex(buffer);
  const retainUntil = retainUntilDate();
  return {
    bucket: 'local-dev-archive',
    key: args.key,
    versionId: `local-${checksum.slice(0, 16)}`,
    etag: `"${checksum}"`,
    checksumSha256: checksum,
    retainUntilDate: retainUntil.toISOString(),
    objectLockMode: null,
    localFallback: true,
    body: buffer,
  };
}

module.exports = {
  archiveConfigured,
  archiveBucket,
  archiveRegion,
  putImmutableObject,
  putImmutableObjectWithOptionalLocalFallback,
  getImmutableObject,
  getSignedArchiveDownloadUrl,
};
