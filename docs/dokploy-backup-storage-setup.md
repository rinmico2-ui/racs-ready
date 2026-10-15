# Set up storage for Dokploy MongoDB backups

An S3-compatible bucket is a private online folder for files. Dokploy saves a database export there. The bucket should be hosted separately from the RACS server so the backup copy remains available if that server fails.

No storage account, destination or backup job has been created during this investigation. The owner's MongoDB Backups tab currently has no configured job and no available destination.

## Free option: Backblaze B2

The owner requires a free option. Backblaze B2 currently provides the first 10 GB of storage free and advertises signup without a credit card. Dokploy supports its S3-compatible API. Use **B2 Cloud Storage**, and create a **private** bucket. The provider's public-bucket verification requirement does not apply to the private-backup setup described here. Free usage still has limits; monitor storage and transfer usage, and do not assume unlimited backups.

1. Register for [Backblaze B2](https://www.backblaze.com/sign-up/cloud-storage-v2) and verify your email. Choose B2 Cloud Storage rather than the separate Computer Backup product.
2. Under **B2 Cloud Storage → Buckets**, create a private bucket such as `racs-backups-marcus`. Bucket names must be available; add a suffix if that name is taken. Copy its S3 endpoint.
3. Under **Application Keys**, create a new **Read and Write** application key restricted to that bucket. Copy `keyID` and `applicationKey` privately. Do not use the master key.
4. In [Dokploy S3 Destinations](https://dokploy.its-au.space/dashboard/settings/destinations), create a destination using the following fields.

| Dokploy field | Backblaze value |
| --- | --- |
| Name | `RACS Free Backups` |
| Provider | The S3-compatible provider matching Backblaze; if not listed, select `Other` |
| Bucket | The exact private bucket name you created |
| Region | The region from your endpoint, for example `us-west-004` |
| Endpoint | `https://` plus the S3 endpoint shown on your bucket, for example `https://s3.us-west-004.backblazeb2.com` |
| Access Key ID | `keyID` from the newly created application key |
| Secret Access Key | `applicationKey` from that key |

5. Test and save the destination. Then open **emak → Backups → Add Backup**, select it, confirm the actual deployed database name, enable the job, save, and run a test backup. Confirm the stored archive as well as the job result. Database-name and restore checks are explained in the common verification steps below.

At the existing archive size of approximately 185 MB, 14 copies would total roughly 2.6 GB. This is only an estimate; newer exports may be larger and hidden/older file versions also consume storage. Start with a daily schedule and a deliberate retention policy after the first current export is measured. Keeping only the latest version of each filename does not remove separately named dated backups. Do not delete the sole verified recovery copy before a new backup is verified.

Sources: [Backblaze pricing](https://www.backblaze.com/cloud-storage/pricing), [no-card signup](https://www.backblaze.com/sign-up/cloud-storage-v2), [private bucket and application-key setup](https://www.backblaze.com/docs/en/cloud-storage-get-started-with-a-backblaze-integration), [Dokploy Backblaze integration](https://docs.dokploy.com/docs/core/backblaze-b2).

A manual database export downloaded to your own computer is another option with no storage-service subscription. The existing October 11 archive is such a local copy; a fresh export is still needed before the planned availability test.

## Cloudflare R2 option

Dokploy supports Cloudflare R2. R2 Standard storage currently includes a monthly free allowance of 10 GB-months plus request allowances. Activating R2 requires a subscription checkout and billing setup; usage above the allowance can incur charges. Review those terms before activating it. Do not select Infrequent Access for the Standard free allowance.

1. Sign in to [Cloudflare](https://dash.cloudflare.com/) and open **Storage & databases → R2 → Overview**. Activate R2 after reviewing the billing terms.
2. Create a **Standard** bucket named `racs-backups`. Leave public access disabled.
3. In R2, open **Manage API tokens** and create a token named `dokploy-racs-backups` with **Object Read & Write**, restricted to `racs-backups`. Keep the generated Access Key ID and Secret Access Key private. Also copy the bucket's S3 API endpoint.
4. In your logged-in Dokploy session, open [Settings → S3 Destinations](https://dokploy.its-au.space/dashboard/settings/destinations) and choose **Create**. If this page or Create is unavailable, the Dokploy owner/administrator needs to configure it or grant destination access.

| Dokploy field | Value |
| --- | --- |
| Name | `RACS Backups` |
| Provider | `Cloudflare R2 Storage` |
| Bucket | `racs-backups` |
| Region | `auto` — the R2 S3 API region |
| Endpoint | Copy the bucket's S3 API endpoint; usually `https://ACCOUNT_ID.r2.cloudflarestorage.com` |
| Access Key ID | The R2-generated Access Key ID |
| Secret Access Key | The R2-generated Secret Access Key |

For a jurisdiction-specific bucket, use the exact endpoint shown by Cloudflare. Do not use a public `r2.dev` URL or the Cloudflare dashboard URL as the S3 endpoint. Enter keys privately in Dokploy rather than sharing them in chat or committing them to Git.

5. **Test** the destination connection, then **Save** it. Return to **emak → Backups → Add Backup** and select the new destination.
6. Enter the actual RACS database name. The service label `emak` and internal host `templates-emak-q9jqps` do not establish that name. To verify it, open the **RACS application** terminal, in its project folder, and run `npm run db:check`. Use the `database=` result; this script performs read-only connection checks and redacts credentials. The local developer environment previously reported `test`, but the deployed application needs its own check.
7. Choose the schedule, enable the job and save. Run its **Test** backup and confirm both a successful job result and a new archive object in the R2 bucket. Check the scheduler's timezone before choosing a particular daily time.
8. Validate restoration into a separate temporary database/server before relying on the backup. An empty destination list or a successful connection test alone does not prove a database backup was created.

MongoDB backups cover database collections, including GridFS files and chunks when their namespaces are included. Check local application uploads and other external assets separately. Dokploy's own server/configuration backup is another distinct backup.

## Official references

- [Dokploy Cloudflare R2 setup](https://docs.dokploy.com/docs/core/cloudflare-r2)
- [Dokploy S3 destination form](https://docs.dokploy.com/docs/core/actions)
- [Dokploy database backups](https://docs.dokploy.com/docs/core/databases/backups)
- [Cloudflare R2 subscription setup](https://developers.cloudflare.com/r2/get-started/)
- [Cloudflare R2 pricing and free allowances](https://developers.cloudflare.com/r2/pricing/)
- [R2 bucket creation and default privacy](https://developers.cloudflare.com/r2/buckets/create-buckets/)
- [R2 access credentials and bucket-scoped permissions](https://developers.cloudflare.com/r2/api/tokens/)
- [R2 S3 region](https://developers.cloudflare.com/r2/api/s3/api/#bucket-region)
