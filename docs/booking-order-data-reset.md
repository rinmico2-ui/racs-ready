# One-time booking/order cleanup

The owner requested removal of **all** bookings, orders and their transaction
dependencies from the live database. The latest instruction cancels demo seeding
and requests that maintenance be disabled.
This operator-only script never runs during application startup or deployment.
Reset/restore has no HTTP endpoint. Recovery downloads require a validated admin
login and are never publicly served. MongoDB must remain private.

## Current operation: delete without seeding and reopen

After deploying this version, open the Dokploy web application's terminal:

```sh
cd /app
node server/scripts/reset-booking-order-data.js --delete-only
```

This is an explicitly destructive command. It uses the same previously reviewed
booking/order dependency scope and exact test-custody acknowledgements documented
below. It creates and fully verifies a **fresh** private compressed recovery
snapshot, then atomically deletes the prepared records and disables maintenance.
It creates no demo bookings, orders, customers, technicians, payments or reports.
Existing accounts, physical inventory, independent counter sales and their returns,
unrelated expenses/payroll, and audit history remain.

Maintenance must still be enabled when the command starts. It switches off only
when deletion and verification succeed in the same transaction. Failed backups,
changed records, custody blockers, unsupported standalone MongoDB, or write errors
leave the data and maintenance setting unchanged. It never executes on deployment.

Success shows `mode: deleted`, `remainingBookings: 0`, `remainingOrders: 0`,
`maintenanceEnabled: false`, and `recoveryVerified: true`. Allow up to 30 seconds
for the running application's settings/report caches to expire, then refresh.
Download the returned `backupDownloadPath` and `checksumDownloadPath` privately
while signed in as admin and preserve both files outside the container. This
one-command operation saves the recovery file on the server before deletion;
unlike the older staged demo workflow below, it does not pause for downloads.
Container storage is temporary and is not an off-server database backup.

The one-time marker also applies to this mode: repeating it does not delete later
real bookings or orders. For recovery, enable maintenance first and use the
`--restore --backup FILE` command below. Only maintenance settings and the settings
timestamp may change between deletion and recovery; other protected record or
configuration changes still block recovery.

## Older staged demo-seeding workflow

The commands below remain available for recovering or inspecting the earlier
prepared demo snapshots. **Do not run the old `--apply` command for the current
deletion-only request**: an earlier prepared snapshot still contains demo seeds.

The default command only reads data. In this older workflow, `--prepare` creates
private recovery files and `--apply --backup FILE` changes the database. All deletion, reservation
cleanup, seeding and the completion marker share one MongoDB transaction.
A standalone MongoDB server is refused; there is no partial-write fallback.

## What changes

- Removes bookings, aircon orders, projects, work orders, assignments, parts
  requests, reports, service material usage, reservations, daily kits, equipment
  assignments and kit returns, including orphan rows in those workflow collections.
- Removes their payments, linked expenses, customer appliance/maintenance records,
  warranty/relocation/unit assistance requests, booking/order ratings, notifications,
  order product returns/refunds/movements and pending related email jobs.
- Clears the reservation counters backed by the removed reservation ledgers and
  changes stale busy technician availability to Offline. It does **not** add back
  sold/consumed stock or treat issued equipment as physically returned.
- Creates **24 completed, fully paid core-service demo bookings**, each with a
  completed assignment, actual-date payment event and approved service report.
  Dates cover the preceding 47 days in Philippine time. Saved demo labor costs
  equal 25% of each booking's value. Unit rates come from an existing priced core
  service; these remain synthetic transactions, not genuine earnings.
- Creates three clearly named, blocked/inactive demo customers with random,
  unrecoverable passwords and `.invalid` emails, plus two inactive demo technicians
  without login accounts. Existing people do not receive fabricated transactions.
  No email, OTP, gateway request, review or stock movement is generated.
- Leaves orders empty. New orders and bookings created after a successful reset
  are protected from accidental repeat runs by a one-time database marker.

Existing accounts/staff, service and product catalogs, physical stock/checkout
counters, independent counter sales and their returns, unrelated expenses,
payroll, legacy technician/product ratings, security/activity/stock audit history
and upload files remain. These retained transactions can still affect analytics.
Receipts and other stored files are not recursively deleted; the recovery snapshot
contains the original document references.

## Run inside the Dokploy web application's terminal

1. Deploy the code containing this script. Open **Admin → Settings → System**
   (`/admin/settings/system`) and enable maintenance mode. Wait at least 30 seconds
   for the existing settings cache to expire. Stop staff activity and close other
   staff tabs: admins are exempt from ordinary maintenance mode. Background workers
   may still run; if they change the snapshot, preparation must be repeated.
2. Open the web application's terminal, then preview:

   ```sh
   cd /app
   node server/scripts/reset-booking-order-data.js
   ```

   Review `deletionCounts`, `seed`, `physicalQuantityChanges` and `blockers`.
   Return issued equipment/unused materials and settle pending kit returns through
   the existing returns screens first. Cancel unissued, physically deducted legacy
   reservations through the normal workflow. The script refuses to fabricate
   returns or replenish stock. The owner explicitly identified the two picked-up
   project-material IDs and three unsettled kit IDs from the October 15 preview
   as test entries where nothing was physically taken. Those exact five IDs are
   recorded in `acknowledgedTestCustody` and the recovery/audit records. Only their
   simulated custody links are allowed through; other issued-equipment, pending
   return and reservation checks still apply. Saved inventory quantities remain
   unchanged; this reset does not reconstruct pre-test inventory counts.
3. Prepare the recovery snapshot. This writes files only, with no database changes:

   ```sh
   node server/scripts/reset-booking-order-data.js --prepare
   ```

   `mode: prepared` includes a private `/app/temp/booking-order-reset-....ejson.gz`
   path and SHA-256 checksum. **Download that file and its `.sha256` sidecar to a
   private location on your computer before applying.** While signed in as admin,
   open each `backupDownloadPath` and `checksumDownloadPath` from the output on
   your site's domain. For example, prefix `/admin/maintenance/...` with
   `https://racsready.its-au.space`. Both files download as attachments; other roles
   cannot access them. Do not post the contents, commit them, or move them into
   public/uploads. Container files can disappear on redeployment. If you cannot
   download and preserve both files outside the container, stop before applying.
   This targeted snapshot is not a complete, off-server database backup.
   The gzip-compressed recovery file stores each full document as an Extended
   JSON record, including saved evidence images. It is streamed to disk and
   decoded again to verify counts, types and the original snapshot fingerprint
   before `recoveryVerified: true` is printed. `compressedBytes`, `expandedBytes`
   and `largestSections` describe its size without exposing document contents.
   Limits remain bounded: 1 GiB expanded, 256 MiB compressed, 128 MiB per record,
   and 50,000 records per section. Applying the reset verifies the file while
   discarding the original document bodies from memory; recovery loads those
   originals. Legacy uncompressed snapshots up to 64 MiB remain readable.
4. Within 30 minutes, substitute the exact path from step 3:

   ```sh
   node server/scripts/reset-booking-order-data.js --apply --backup /app/temp/EXACT-FILE.ejson.gz
   ```

   Success is `mode: reset-and-seeded`. A changed snapshot, failed write, custody
   problem or verification failure rolls the transaction back. Only IDs in the
   prepared snapshot are deleted. Concurrent requests must remain stopped; this
   maintenance tool does not place a database-wide lock on other application
   processes. It must not be run during active customer/staff use.
5. Keep maintenance enabled while checking Bookings (24 completed demo rows),
   Orders (empty), technician work (no pending demo jobs), and Service Reports / Sales
   and Payments with **Last 90 days**. Allow the report cache 30 seconds to expire.
   Demo payments must equal demo approved work value, with zero demo balance.
   Existing counter sales/payroll/unrelated expenses remain separate contributions.
   Turn maintenance off after verification.

Share only the aggregate terminal output for troubleshooting, never the recovery
file. `already-applied` means no further reset or seed was performed.

## Recovery

While maintenance is still enabled and before any subsequent work changes the
affected records, use the same private files:

```sh
node server/scripts/reset-booking-order-data.js --restore --backup /app/temp/EXACT-FILE.ejson.gz
```

Restore removes the exact seeded IDs, restores deleted documents and the changed
tool/technician fields, and retains an audit event for both operations. Original
pending email jobs are restored too; their normal worker may resume sending them.
Restore refuses changed records, inventory, catalog, settings or demo identities
instead of overwriting newer work. If refused, preserve both the snapshot and the
current database and arrange a selective recovery; do not delete the marker or
manually overwrite live collections.
