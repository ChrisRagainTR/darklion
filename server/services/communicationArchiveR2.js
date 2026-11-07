'use strict';

const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { sha256Hex, retainUntilDate } = require('./communicationArchiveCanonical');

const LEGACY_PREFIX = '__legacy_s3_versions__/';
const VERSION_PREFIX = 'r2-sha256-';
const fail = (code, statusCode = 503) => Object.assign(new Error(code), { code, statusCode });
const missing = e => e.$metadata?.httpStatusCode === 404 || e.name === 'NoSuchKey';

// A copied S3 version keeps its original ID in receipts and signed manifests.
// There is no AWS fallback: an absent migrated version fails closed.
function legacyVersionKey(key, versionId) {
  if (!key || !versionId) throw fail('ARCHIVE_VERSION_REQUIRED');
  return LEGACY_PREFIX + sha256Hex(JSON.stringify([key, versionId]));
}

function r2Configuration(env) {
  const bucket = env.COMMUNICATION_ARCHIVE_BUCKET;
  if (!bucket || !env.COMMUNICATION_ARCHIVE_ACCESS_KEY_ID || !env.COMMUNICATION_ARCHIVE_SECRET_ACCESS_KEY) {
    throw fail('ARCHIVE_CREDENTIALS_INCOMPLETE');
  }
  let endpoint;
  try { endpoint = new URL(env.COMMUNICATION_ARCHIVE_R2_ENDPOINT); } catch (_) { throw fail('INVALID_ARCHIVE_R2_ENDPOINT'); }
  if (endpoint.protocol !== 'https:' || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw fail('INVALID_ARCHIVE_R2_ENDPOINT');
  }
  if (env.COMMUNICATION_ARCHIVE_OBJECT_LOCK_ENABLED === 'true' || env.COMMUNICATION_ARCHIVE_EXPECTED_BUCKET_OWNER
      || env.COMMUNICATION_ARCHIVE_SESSION_TOKEN) throw fail('R2_ARCHIVE_FORBIDS_AWS_OPTIONS');
  // This assertion must be accompanied by operator verification of actual locks.
  // R2 configuration administrators can remove locks; this is not COMPLIANCE mode.
  if (env.COMMUNICATION_ARCHIVE_R2_BUCKET_LOCK_ENABLED !== 'true') throw fail('R2_ARCHIVE_REQUIRES_BUCKET_LOCK');
  return { bucket, endpoint: endpoint.origin };
}

async function bytes(body) {
  if (Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function createR2Archive({ env = process.env, client, sign = getSignedUrl } = {}) {
  const { bucket, endpoint } = r2Configuration(env);
  client ||= new S3Client({ endpoint, region: 'auto',
    credentials: { accessKeyId: env.COMMUNICATION_ARCHIVE_ACCESS_KEY_ID, secretAccessKey: env.COMMUNICATION_ARCHIVE_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });

  function physicalKey(key, versionId) {
    if (!key || key.startsWith(LEGACY_PREFIX)) throw fail('INVALID_ARCHIVE_KEY', 400);
    if (!versionId || /^r2-sha256-[a-f0-9]{64}$/.test(versionId)) return key;
    return legacyVersionKey(key, versionId);
  }

  async function read(key, versionId) {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: physicalKey(key, versionId) }));
    const body = await bytes(result.Body), checksum = sha256Hex(body);
    if (result.Metadata?.content_sha256 !== checksum) throw fail('ARCHIVE_CHECKSUM_MISMATCH');
    if (versionId?.startsWith(VERSION_PREFIX) && versionId !== VERSION_PREFIX + checksum) throw fail('ARCHIVE_VERSION_MISMATCH');
    if (versionId && !versionId.startsWith(VERSION_PREFIX)
        && (result.Metadata?.['dl-source-version'] !== versionId || result.Metadata?.['dl-source-key-sha256'] !== sha256Hex(key))) {
      throw fail('ARCHIVE_VERSION_MISMATCH');
    }
    return { result, body, checksum };
  }

  async function getImmutableObject({ key, versionId = null }) {
    const { result, body, checksum } = await read(key, versionId);
    return { bucket, key, versionId: versionId || VERSION_PREFIX + checksum,
      contentType: result.ContentType || 'application/octet-stream', body, checksumSha256: checksum };
  }

  async function putImmutableObject({ key, body, contentType = 'application/json', metadata = {} }) {
    physicalKey(key, null);
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const checksum = sha256Hex(buffer);
    let alreadyExisted = false;
    const existing = async () => {
      try { return await read(key, null); } catch (e) { if (missing(e)) return null; throw e; }
    };
    let stored = await existing();
    if (!stored) {
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType,
          IfNoneMatch: '*', Metadata: { ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)])),
            content_sha256: checksum, 'dl-retain-until': retainUntilDate().toISOString(), 'dl-retention-mode': 'R2_BUCKET_LOCK' } }));
      } catch (e) {
        // A concurrent conditional create or bucket-lock rejection may mean the
        // same immutable key already exists. Verify bytes, never trust metadata alone.
        if (![403, 409, 412].includes(e.$metadata?.httpStatusCode)) throw e;
        stored = await existing();
        if (!stored) throw e;
        alreadyExisted = true;
      }
    } else alreadyExisted = true;
    stored ||= await read(key, null);
    if (stored.checksum !== checksum) throw fail('ARCHIVE_CHECKSUM_CONFLICT', 409);
    return { bucket, key, versionId: VERSION_PREFIX + checksum, etag: stored.result.ETag || null,
      checksumSha256: checksum, retainUntilDate: stored.result.Metadata?.['dl-retain-until'] || null,
      objectLockMode: 'R2_BUCKET_LOCK', alreadyExisted };
  }

  async function getSignedArchiveDownloadUrl({ key, versionId = null, filename = null, expiresIn = 900 }) {
    const physical = physicalKey(key, versionId);
    // Establish that the requested version exists before issuing a link. Reading
    // versioned payloads through getImmutableObject also verifies their bytes.
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: physical }));
    const checksum = head.Metadata?.content_sha256;
    if (!/^[a-f0-9]{64}$/.test(checksum || '')) throw fail('ARCHIVE_CHECKSUM_MISSING');
    if (versionId?.startsWith(VERSION_PREFIX) && versionId !== VERSION_PREFIX + checksum) throw fail('ARCHIVE_VERSION_MISMATCH');
    if (versionId && !versionId.startsWith(VERSION_PREFIX) && head.Metadata?.['dl-source-version'] !== versionId) throw fail('ARCHIVE_VERSION_MISMATCH');
    return sign(client, new GetObjectCommand({ Bucket: bucket, Key: physical,
      ...(filename ? { ResponseContentDisposition: `attachment; filename="${String(filename).replace(/["\r\n]/g, '')}"` } : {}) }), { expiresIn });
  }
  return { putImmutableObject, getImmutableObject, getSignedArchiveDownloadUrl };
}

module.exports = { createR2Archive, r2Configuration, legacyVersionKey, LEGACY_PREFIX, VERSION_PREFIX };
