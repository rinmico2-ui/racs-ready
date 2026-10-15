# Remove the owner-requested expense entries

The owner requested removal of the current entries on
`/admin/appointments/expenses`. This one-time operator cleanup includes approved,
pending and rejected expenses and notifications referencing their exact Expense
IDs. It does not delete payroll, POS sales, product costs, bookings/orders,
inventory, staff, receipt files, or audit history. Maintenance mode is unchanged.
It has no HTTP mutation endpoint and never runs during startup or deployment.

After deployment, open a new Dokploy web-application terminal:

```sh
cd /app
node server/scripts/clear-expenses.js --apply
```

Omit `--apply` for a read-only preview. Output includes aggregate counts and
amounts by approval status, without descriptions, staff identities or receipts.
The command writes and verifies a private compressed recovery backup, then
deletes only the backed-up IDs in a MongoDB transaction alongside an audit entry
and one-time completion marker. Standalone MongoDB is refused. Changed records
or failed writes roll the operation back. Expenses created after the snapshot
are preserved, and repeat runs cannot delete later expenses.

Success shows `mode: deleted`, `atomic: true` and `recoveryVerified: true`.
Download the returned `backupDownloadPath` and `checksumDownloadPath` on the
site's domain while signed in as admin; save both privately outside the
container. Never post backup contents or put them in public/uploads. Container
storage is temporary. Receipt files remain in their original storage.

Wait 30 seconds, then refresh Expenses and Sales and Payments. Report impact
depends on the selected dates and existing saved job costs; other payroll and
product costs can still affect profit. No money is refunded or moved.

To recover using the exact file printed by the cleanup:

```sh
node server/scripts/clear-expenses.js --restore --backup /app/temp/expense-reset-EXACT-FILE.ejson.gz
```

Recovery verifies the file checksum and operation/database identity. It refuses
existing document IDs rather than overwriting newer work. Original expenses and
notifications are restored atomically; old audit events remain and cleanup
reruns stay disabled.
