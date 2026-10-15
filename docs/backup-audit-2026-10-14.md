# Backup verification — October 14, 2026

## Conclusion

A local MongoDB archive exists and passes gzip integrity and archive-header checks. Its last modification was October 11, 2026. The owner subsequently reported an empty native MongoDB Backups list and no destination available when adding a job. No native Dokploy backup job is currently configured for this service based on that report. A current offsite copy, any separate host backup automation, and a successful restore have **not** been verified. This does not establish readiness for an availability test against production.

## Evidence checked

| Check | Result | Limit |
| --- | --- | --- |
| Live home page | HTTP 200, CALIDRO RACS | One ordinary GET; no capacity or attack test |
| Live `/ready` and `/health` | HTTP 200, database connected | Availability only; no backup information |
| Dokploy destination page | Redirected to the unauthenticated root | No dashboard account, API credential or server session available to inspect jobs |
| Owner-provided MongoDB service link | Native MongoDB service route; direct GET also redirected to Dokploy sign-in | Confirms which service type to inspect, not its backup configuration |
| Owner's Backups-tab report | Empty backup list and no destination when adding a backup | No native service backup job configured; other server automation remains unknown |
| Local archive | `Downloads/racs-mongodb-20261011-132150.archive.gz`, 185,464,539 bytes | Existing file only; no new database export |
| File modification | October 11, 2026, 13:24:39 Asia/Manila | File timestamp does not prove the database's export consistency |
| Gzip integrity | Passed while decompressing the complete stream, 256,765,096 bytes | Does not prove a successful MongoDB restore |
| Archive header | Valid MongoDB archive signature; format 0.1; tool 100.19.1; source server 8.3.11 | Header metadata only |
| Database metadata | 139 collection entries overall; 69 for `test`, the database selected by the local `.env` | Deployed application's database name has not been checked |
| Core collections | `users`, `orders`, `payments`, `bookingservices`, `inventories` present for `test` | No comparison with the current production collection set or document counts |
| File collections | Payment-proof and completion-proof GridFS files/chunks present for `test` | Newer buckets, external Cloudinary assets and filesystem uploads are not established as covered |
| Oplog entry | Not present in archive metadata | No point-in-time consistency guarantee was established |
| Repository automation | No complete database backup scheduler or deployment backup job found; partial migration recovery snapshots exist | Dokploy or host automation may exist outside the repository |
| Restore exercise | Not performed | No data was imported or overwritten |

Archive SHA-256: `9ed754317d48ab3a9dea5c2fa75fcbd52761c93f844e08a0f7d5637b6d586ec9`.

No customer documents, connection passwords or API keys were printed. No application code, infrastructure configuration or production database records were changed. The gzip check streamed the archive without writing a decompressed copy.

## What remains to verify in Dokploy

The current setup blocker is the missing storage destination. In the owner's logged-in Dokploy session, open [Settings → S3 Destinations](https://dokploy.its-au.space/dashboard/settings/destinations), create a destination for an existing external S3-compatible bucket, enter the provider's endpoint, region, bucket and access credentials privately, and test its connection. If there is no bucket yet, create storage with the selected provider first. If destination creation is unavailable, the Dokploy owner/administrator needs to configure it or grant the required access. Return to the MongoDB Backups tab only after the destination is saved. A prefix is a folder/name grouping within the bucket and does not create a destination.

The owner is unfamiliar with object-storage buckets and requires a free option. A [step-by-step storage setup guide](dokploy-backup-storage-setup.md) now leads with Backblaze B2's 10 GB free storage allowance and no-card signup for a private bucket. It also documents Cloudflare R2 as an alternative with billing setup, destination field mappings, database-name verification, and the checks needed to establish a successful backup. No cloud account or backup destination has been created.

1. Confirm the database name used by the deployed RACS application, rather than assuming the developer machine's `.env` is identical.
2. Open that MongoDB service's Backup tab. Verify its job is enabled and has the correct database, S3 destination, schedule and retention policy. Confirm the latest successful run and the corresponding stored archive's time and size. For MongoDB deployed through Docker Compose, inspect its actual scheduled dump job instead of assuming a native database backup is configured.
3. Take a fresh backup before the proposed test. Restore it into a separate temporary database or server and validate collection counts, indexes, application reads and stored proofs. Do not test restoration over production.
4. Verify persistent application uploads and external image storage are covered separately where needed. MongoDB GridFS content is included only when the relevant files and chunks collections are dumped.
5. Back up Dokploy's own configuration and recovery access. Its server backup saves `dokploy-postgres` and `/etc/dokploy`; that is distinct from backing up RACS MongoDB and application data volumes.

Backups provide recovery after data loss; they do not keep a server available during overload. The repository contains request and concurrency controls, but the deployed code, proxy configuration, host limits and upstream protection have not been audited here. The existing October 1 DoS review discusses Railway and must not be treated as evidence of Dokploy host protection.

Prefer a controlled availability test on a staging deployment with clear traffic limits and a stop condition. A fresh, restorable backup and a recovery plan should be verified before an intentional production disruption.

## Primary references

- [Dokploy database backups](https://docs.dokploy.com/docs/core/databases/backups)
- [Dokploy server backups and their scope](https://docs.dokploy.com/docs/core/backups)
- [Dokploy volume backups](https://docs.dokploy.com/docs/core/volume-backups)
- [MongoDB self-managed backup methods](https://www.mongodb.com/docs/manual/core/backups/)
- [MongoDB archive format](https://github.com/mongodb/mongo-tools/blob/master/common/archive/archive.go)
- [MongoDB restore options](https://www.mongodb.com/docs/database-tools/mongorestore/)
