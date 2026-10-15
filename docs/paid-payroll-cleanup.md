# Remove the owner-requested paid payroll data

This one-time operator command deletes only payroll with `status: paid` that
exists when the command starts, plus notifications pointing to those exact
Payroll IDs. It does not run on startup or deployment and has no HTTP mutation
endpoint. Existing paid payroll was preserved by the booking/order cleanup;
this is a separate, explicitly requested operation.

After deployment, use the Dokploy web application's terminal:

```sh
cd /app
node server/scripts/clear-paid-payroll.js --apply
```

Omit `--apply` for a read-only preview. The command prints aggregate counts and
gross/net payroll totals, not employee names, payment references or proof files.
It first writes and verifies a private compressed recovery backup, then deletes
the exact backed-up IDs in a MongoDB transaction with the completion marker and
audit entry. It refuses standalone MongoDB, changed records and payroll still
referenced by customer payment deductions. A failed write rolls everything back.
No payment, wage refund, email or physical stock movement is generated.

Draft, approved-but-unpaid and voided payroll remain, as do attendance, accounts,
salary rates, payroll templates, expenses, POS sales and old audit events.
Maintenance mode is unchanged. Reports include approved payroll as well as paid
payroll, so removing paid entries does not necessarily make profit zero.
Allow 30 seconds for report caches, then refresh Payroll and Sales and Payments.

Success shows `mode: deleted`, `atomic: true`, `recoveryVerified: true`, the deleted
paid count, and the gross payroll amount removed from reports. It also prints
private `backupDownloadPath` / `checksumDownloadPath` URLs. Open both on the site's
domain while signed in as admin and save the files privately outside the
container. Never post their contents or move them into public/uploads. Container
storage is temporary. `already-applied` protects future payroll from repeat runs.

To recover using that exact file:

```sh
node server/scripts/clear-paid-payroll.js --restore --backup /app/temp/paid-payroll-reset-EXACT-FILE.ejson.gz
```

Recovery verifies the checksum and operation/database identity, refuses existing
IDs or overlapping replacement payroll periods, and restores the original paid
records/notifications atomically. Audit history is retained and later cleanup
reruns stay disabled. Uploaded payment proof files are never deleted.
