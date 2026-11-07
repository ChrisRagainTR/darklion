#!/usr/bin/env node
'use strict';

// Read-only on S3. Copy every version, including legacy documents, into a
// dedicated retained R2 bucket. Keep original archive keys for unversioned
// export links and deterministic addresses for historical version references.
const fs = require('node:fs');
const { S3Client, ListObjectVersionsCommand, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { sha256Hex } = require('../server/services/communicationArchiveCanonical');
const { legacyVersionKey, LEGACY_PREFIX, r2Configuration } = require('../server/services/communicationArchiveR2');
const immutableArchiveKey = key => /^(events\/firm\/|attachments\/firm\/|exports\/)/.test(key);
const missing = e => e.$metadata?.httpStatusCode === 404 || e.name === 'NoSuchKey';

async function readObject(client, args) {
  const result = await client.send(new GetObjectCommand(args));
  const body = Buffer.from(await result.Body.transformToByteArray());
  return { result, body, checksum: sha256Hex(body) };
}

async function copyVersion({ source, target, sourceBucket, targetBucket, version }) {
  const { Key: key, VersionId: versionId } = version;
  if (!key || !versionId || key.startsWith(LEGACY_PREFIX)) throw new Error('INVALID_SOURCE_VERSION');
  const original = await readObject(source, { Bucket: sourceBucket, Key: key, VersionId: versionId });
  const metadata = { ...original.result.Metadata, content_sha256: original.checksum,
    'dl-source-bucket': sourceBucket, 'dl-source-key-sha256': sha256Hex(key), 'dl-source-version': versionId,
    'dl-retention-mode': 'R2_BUCKET_LOCK' };
  if (original.result.Metadata?.content_sha256 && original.result.Metadata.content_sha256 !== original.checksum) {
    throw new Error('SOURCE_ARCHIVE_CHECKSUM_MISMATCH');
  }
  const keys = [legacyVersionKey(key, versionId)];
  if (version.IsLatest && immutableArchiveKey(key)) keys.push(key);
  for (const targetKey of keys) {
    let existing;
    try { existing = await readObject(target, { Bucket: targetBucket, Key: targetKey }); }
    catch (e) { if (!missing(e)) throw e; }
    if (!existing) {
      try {
        await target.send(new PutObjectCommand({ Bucket: targetBucket, Key: targetKey, Body: original.body,
          ContentType: original.result.ContentType || 'application/octet-stream', Metadata: metadata, IfNoneMatch: '*' }));
      } catch (e) { if (![403, 409, 412].includes(e.$metadata?.httpStatusCode)) throw e; }
      existing = await readObject(target, { Bucket: targetBucket, Key: targetKey });
    }
    if (existing.checksum !== original.checksum || existing.result.Metadata?.content_sha256 !== original.checksum
        || existing.result.Metadata?.['dl-source-version'] !== versionId
        || existing.result.Metadata?.['dl-source-bucket'] !== sourceBucket
        || existing.result.Metadata?.['dl-source-key-sha256'] !== sha256Hex(key)) {
      throw new Error('MIGRATION_DESTINATION_CONFLICT');
    }
  }
  return { key, versionId, isLatest: !!version.IsLatest, bytes: original.body.length, sha256: original.checksum,
    targetKeys: keys, sourceObjectLockMode: original.result.ObjectLockMode || null,
    sourceRetainUntil: original.result.ObjectLockRetainUntilDate || null };
}

async function inventory(source, bucket) {
  const versions = [], deleteMarkers = [];
  let KeyMarker, VersionIdMarker;
  do {
    const page = await source.send(new ListObjectVersionsCommand({ Bucket: bucket, KeyMarker, VersionIdMarker }));
    versions.push(...(page.Versions || []));
    deleteMarkers.push(...(page.DeleteMarkers || []));
    if (!page.IsTruncated) break;
    if (!page.NextKeyMarker) throw new Error('INVALID_VERSION_PAGINATION');
    KeyMarker = page.NextKeyMarker; VersionIdMarker = page.NextVersionIdMarker;
  } while (true);
  return { versions, deleteMarkers };
}

async function main() {
  const configFile = process.env.ARCHIVE_MIGRATION_CONFIG, outputFile = process.env.ARCHIVE_MIGRATION_REPORT;
  if (!configFile || !outputFile) throw new Error('PRIVATE_MIGRATION_CONFIG_AND_REPORT_REQUIRED');
  const stat = fs.statSync(configFile);
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('MIGRATION_CONFIG_MUST_BE_PRIVATE');
  const config = JSON.parse(fs.readFileSync(configFile));
  const { bucket: targetBucket, endpoint } = r2Configuration(config.target);
  if (!config.source?.bucket || !config.source?.region || !config.source?.credentials) throw new Error('SOURCE_CONFIG_REQUIRED');
  const source = new S3Client({ region: config.source.region, credentials: config.source.credentials });
  const target = new S3Client({ region: 'auto', endpoint, credentials: {
    accessKeyId: config.target.COMMUNICATION_ARCHIVE_ACCESS_KEY_ID,
    secretAccessKey: config.target.COMMUNICATION_ARCHIVE_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  try {
    const snapshot = await inventory(source, config.source.bucket);
    const report = { startedAt: new Date().toISOString(), sourceBucket: config.source.bucket, targetBucket,
      sourceVersionCount: snapshot.versions.length, sourceBytes: snapshot.versions.reduce((n, v) => n + (v.Size || 0), 0),
      deleteMarkers: snapshot.deleteMarkers, copied: [], applied: process.argv.includes('--apply'), complete: false };
    const save = () => {
      const fd = fs.openSync(outputFile, 'w', 0o600);
      try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify(report, null, 2) + '\n'); } finally { fs.closeSync(fd); }
    };
    save();
    console.log(JSON.stringify({ versions: report.sourceVersionCount, bytes: report.sourceBytes,
      deleteMarkers: snapshot.deleteMarkers.length, apply: report.applied }));
    if (!report.applied) return;
    // A bucket is dedicated to one source bucket, so original key/version pairs
    // cannot collide with an unrelated migration's namespace.
    for (let i = 0; i < snapshot.versions.length; i += 16) {
      const batch = await Promise.all(snapshot.versions.slice(i, i + 16).map(version => copyVersion({
        source, target, sourceBucket: config.source.bucket, targetBucket, version })));
      report.copied.push(...batch); if (i % 128 === 0) save();
      if (i % 128 === 0) console.log(JSON.stringify({ verifiedVersions: report.copied.length }));
    }
    const final = await inventory(source, config.source.bucket);
    const fingerprint = data => sha256Hex(JSON.stringify([
      data.versions.map(v => [v.Key, v.VersionId, v.IsLatest]).sort(),
      data.deleteMarkers.map(v => [v.Key, v.VersionId, v.IsLatest]).sort(),
    ]));
    report.sourceInventoryStable = fingerprint(snapshot) === fingerprint(final);
    report.complete = report.sourceInventoryStable;
    report.completedAt = new Date().toISOString(); save();
    const receiptKey = 'migration-receipts/' + sha256Hex(fs.readFileSync(outputFile)) + '.json';
    await target.send(new PutObjectCommand({ Bucket: targetBucket, Key: receiptKey, Body: fs.readFileSync(outputFile),
      ContentType: 'application/json', IfNoneMatch: '*' }));
    console.log(JSON.stringify({ complete: report.complete, verifiedVersions: report.copied.length,
      sourceInventoryStable: report.sourceInventoryStable, sourceModified: false }));
    if (!report.complete) process.exitCode = 2;
  } finally { source.destroy(); target.destroy(); }
}

if (require.main === module) main().catch(e => { console.error(JSON.stringify({ error: e.code || e.name, status: e.$metadata?.httpStatusCode })); process.exitCode = 1; });
module.exports = { copyVersion, inventory, immutableArchiveKey };
