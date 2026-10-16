# Delete bookings and orders scheduled October 15–20, 2026

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
node server/scripts/clear-scheduled-bookings-orders.js --from 2026-10-15 --to 2026-10-20
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

## 2. Prepare recovery files

Enable Maintenance Mode at `/admin/settings/system`. Stop staff activity and
close other staff tabs; admin users can still write during maintenance. Wait
30 seconds for the maintenance cache to expire, then run:

```sh
node server/scripts/clear-scheduled-bookings-orders.js --from 2026-10-15 --to 2026-10-20 --prepare
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
node server/scripts/clear-scheduled-bookings-orders.js --from 2026-10-15 --to 2026-10-20 --apply --backup /app/temp/EXACT-FILE.ejson.gz
```

The command verifies the backup and rechecks the selected records and their
dependencies inside a MongoDB transaction. Changed records require a new
preparation. Any write failure rolls the deletion and its marker back together.
Standalone MongoDB is refused. It never falls back to partial deletion.

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

## Recovery

Enable maintenance and stop staff writes again. Use the same dates and the saved
private recovery file:

```sh
node server/scripts/clear-scheduled-bookings-orders.js --from 2026-10-15 --to 2026-10-20 --restore --backup /app/temp/EXACT-FILE.ejson.gz
```

Recovery restores exact backed-up documents in one transaction, preserving the
cleanup audit trail. It refuses mismatched databases/date ranges, a wrong backup,
or IDs already present rather than overwriting current records. Restored queued
email jobs may resume sending through the normal worker. Maintenance remains
unchanged until you disable it yourself.
