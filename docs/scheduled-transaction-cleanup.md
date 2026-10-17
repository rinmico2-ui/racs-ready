# Delete bookings and orders scheduled October 15–21, 2026

This operator-only command is separate from the previous whole-database reset.
It never runs during deployment or application startup. It creates no seed data.

The inclusive date range uses Philippine time (`Asia/Manila`): service
`bookingDate`, order `delivery.preferredDate`, or `pickupDate` for a customer
pickup order. Creation dates and payment dates do not determine selection.
All transaction statuses in the date range are included. An order's linked
installation booking is included even if its stored calendar date differs;
the preview reports these additional linked installations separately.

## 1. Preview in the Dokploy application terminal

After the deployment containing the script succeeds, open a **new** application
terminal. Preview works while maintenance is disabled:

```sh
cd /app
node server/scripts/clear-scheduled-bookings-orders.js --from 2026-10-15 --to 2026-10-21
```

This reads records and prints aggregate deletion counts, payment amounts by
status, and any blockers. It does not delete records or enable maintenance.
Share this JSON output for review, without passwords or backup contents.

Linked payments, assignments, projects, work orders, reports, material usage,
settled kit/equipment records, assets, maintenance schedules, assistance requests,
warranties, returns/refunds, ratings, expenses and exact related notifications
are included. Pending related email jobs are matched by exact work IDs or
references; OTP/security emails and unrelated messages remain.

Shared dependencies that also point to work outside the range block cleanup.
The command does not expand the range to delete that other work. Unresolved
equipment custody, pending returns and active stock reservations also block it.
Settle or release these through their normal workflows first. Past test-custody
exceptions from the whole-database reset are not carried into this operation.

On October 17, the owner confirmed that the following live-preview records are
**test entries only, with nothing physically taken**:

- Equipment: `6ad1109a0444f9852ad6c52e`, `6ad1109a0444f9852ad6c52f`,
  `6ad1109a0444f9852ad6c530`.
- Daily kit: `6ad110780444f9852ad6c460`.

Only the exact October 15-21 range acknowledges these records. The preview,
private recovery artifact, completion marker and audit event record this exception.
Other issued equipment, unsettled kits, shared outside-range dependencies and
pending returns still block cleanup. Even an acknowledged equipment reservation
must be released through the normal workflow first, so that its stock hold is
not stranded. The exception does not mark anything physically returned, replenish
inventory or reconstruct counts changed by earlier tests.

## 2. Prepare recovery files

Enable Maintenance Mode at `/admin/settings/system`. Stop staff activity and
close other staff tabs; admin users can still write during maintenance. Wait
30 seconds for the maintenance cache to expire and let any workflow already in
progress finish, then run:

```sh
node server/scripts/clear-scheduled-bookings-orders.js --from 2026-10-15 --to 2026-10-21 --prepare
```

Proceed only when the output says `mode: prepared`, `blockers: []` and
`recoveryVerified: true`. This step writes a private compressed recovery file
and its SHA-256 checksum without changing database records.

Download both `backupDownloadPath` and `checksumDownloadPath` by prefixing them
with `https://racsready.its-au.space` in your signed-in admin browser. Keep both
files privately on your computer. Do not post their contents, commit them or put
them in public/uploads. Container storage can disappear on redeployment. This
targeted recovery file is not a full database backup.

## 3. Apply the exact prepared deletion

Within 30 minutes of preparation, substitute the **exact** `backup` path printed
in step 2:

```sh
node server/scripts/clear-scheduled-bookings-orders.js --from 2026-10-15 --to 2026-10-21 --apply --backup /app/temp/EXACT-FILE.ejson.gz
```

The command verifies the backup and rechecks the selected records and their
dependencies inside a MongoDB transaction. Changed records require a new
preparation. Any write failure rolls the deletion and its marker back together.
Standalone MongoDB is refused. It never falls back to partial deletion.

### If records changed after preparation

This error means **no deletion occurred**. Automatic daily-kit preparation,
assignment expiry, booking-delay monitoring, appointment reminders, aftercare
reminders and equipment-return reminders now pause before starting a scheduled
cycle while maintenance is enabled. They read the current database setting
rather than another instance's cached HTTP setting. The kit worker also checks
between targets and after acquiring its generation lease. An operation already
in progress can finish; maintenance does not cancel an in-flight transaction.
Authentication and its email worker remain available for administrator access.

Keep maintenance enabled and close other staff/admin tabs. Admin activity,
notification read updates and already-running tasks can still change a prepared
snapshot. The cleanup continues to reject every changed snapshot, including
timestamp-only changes; there is no force-delete flag.

After an apply mismatch, JSON includes `changes.collections` with counts of
added, removed and modified records plus the top-level field names that changed.
It contains no customer details, payment evidence or backed-up field values.
You can also compare a saved preparation without deleting anything:

```sh
node server/scripts/clear-scheduled-bookings-orders.js --from 2026-10-15 --to 2026-10-21 --compare --backup /app/temp/EXACT-FILE.ejson.gz
```

Once activity has stopped, run `--prepare` again and download the new recovery
file and checksum. Apply using that **new** path within 30 minutes. An old
preparation is never rewritten or silently updated. Deployment can replace
`/app/temp`, so a new container generally needs a new preparation even when an
old backup was downloaded. Keep the old private files for recovery evidence.

Success shows `mode: deleted` and `atomic: true`. Allow 30 seconds for report
caches, then check Bookings, Orders and Payments. Disable Maintenance Mode in
Admin System Settings when checks are complete; the script leaves that setting
unchanged. A completion marker prevents a repeated command for the same range
from deleting later transactions.

Existing accounts/staff, physical inventory and reservation counters, unrelated
bookings/orders, independent POS sales, unrelated payroll/expenses, upload files
and security/stock audit history are preserved. Sold or consumed stock is not
added back, and paid transactions are not refunded. Deleting the selected
financial records changes the corresponding reports. Historical seed manifests
are retained; this cleanup does not replace deleted demonstration transactions.

## Re-running the same range

The completion marker normally stops `--preview`, `--prepare` and `--apply` for
a range whose cleanup already ran, so bookings or orders created **after** the
apply step are never deleted automatically. To clear a second batch inside the
same range, add `--rerun` to the read-only and destructive steps:

```sh
node server/scripts/clear-scheduled-bookings-orders.js --from 2026-10-15 --to 2026-10-21 --rerun
node server/scripts/clear-scheduled-bookings-orders.js --from 2026-10-15 --to 2026-10-21 --rerun --prepare
node server/scripts/clear-scheduled-bookings-orders.js --from 2026-10-15 --to 2026-10-21 --rerun --apply --backup /app/temp/EXACT-FILE.ejson.gz
```

`--rerun` does not bypass any other safeguard. Maintenance mode is still
required for prepare and apply; a fresh preparation is always written (existing
checkmarks in this guide apply unchanged); a changed snapshot still aborts with
no changes. The rerun pass deletes only the records currently matching the
range snapshot, refreshes the completion marker in the same transaction, and
writes a second `SCHEDULED_TRANSACTIONS_REMOVED` audit event. Shared
dependencies, unsettled custody, open returns or a changed test-custody
acknowledgement still block the rerun. `--rerun` cannot combine with
`--compare` or `--restore`.

## Recovery

Enable maintenance and stop staff writes again. Use the same dates and the saved
private recovery file:

```sh
node server/scripts/clear-scheduled-bookings-orders.js --from 2026-10-15 --to 2026-10-21 --restore --backup /app/temp/EXACT-FILE.ejson.gz
```

Recovery restores exact backed-up documents in one transaction, preserving the
cleanup audit trail. It refuses mismatched databases/date ranges, a wrong backup,
or IDs already present rather than overwriting current records. Restored queued
email jobs may resume sending through the normal worker. Maintenance remains
unchanged until you disable it yourself.
