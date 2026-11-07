# Compliance Communications Archive Infrastructure

This directory documents the archive foundation for DarkLion communications.

## MVP configuration

The MVP requires only a private S3 bucket and the application's existing AWS
credentials. Exports include SHA-256 checksums. Object Lock, replication, and
KMS signing are deferred hardening controls and are not required to run the
archive.

- Set `COMMUNICATION_ARCHIVE_BUCKET` and `COMMUNICATION_ARCHIVE_REGION`.
- Keep S3 Block Public Access enabled.
- Deny routine application access to S3 deletion APIs.
- Optionally set `COMMUNICATION_ARCHIVE_OBJECT_LOCK_ENABLED=true` only after
  moving to an Object Lock-enabled bucket.

## Future hardening

## Required AWS resources

1. Dedicated archive/security AWS account (preferred).
2. Primary Object Lock bucket, for example `darklion-communications-archive`.
3. Replica Object Lock bucket, for example `darklion-communications-archive-replica`.
4. Dedicated KMS CMK for SSE-KMS encryption.
5. Dedicated KMS signing key or HMAC secret for export signatures until asymmetric KMS signing is wired.
6. CloudTrail trail with data events and log-file integrity validation.
7. S3 Inventory for both archive buckets.

## Bucket requirements

- Versioning enabled
- Object Lock enabled
- Default retention: COMPLIANCE mode, 7 years
- Explicit object-level `ObjectLockMode=COMPLIANCE` and `ObjectLockRetainUntilDate` on every write
- Block all public access
- TLS-only bucket policy
- Bucket-owner-enforced ownership
- Replication of locked object versions and Object Lock metadata
- No application principal may call `s3:DeleteObject`, `s3:DeleteObjectVersion`, or retention-shortening APIs

## Application environment variables

- `COMMUNICATION_ARCHIVE_BUCKET` (required in production)
- `COMMUNICATION_ARCHIVE_REGION`
- `COMMUNICATION_ARCHIVE_OBJECT_LOCK_ENABLED=true` (optional hardening)
- `COMMUNICATION_ARCHIVE_FAIL_CLOSED=true` (default when bucket is configured or NODE_ENV=production)
- `COMMUNICATION_ARCHIVE_ALLOW_LOCAL_FALLBACK=true` only for non-production local tests

## Current production note

Live production currently has:

- `darklion-documents` (us-east-2)
- `darklion-documents-backup` (us-west-2)

Those buckets are disaster-recovery replicas only. They do **not** have Object Lock and must not be used as the compliance archive.

## Deployment order

1. Configure the private archive bucket. Object Lock is optional for the MVP.
2. Deploy application schema and capture code.
3. Run historical backfill: `npm run archive:backfill`.
4. Generate a date-range export and verify with `npm run archive:verify-export`.
5. Complete legal/security acceptance before claiming compliance readiness.
