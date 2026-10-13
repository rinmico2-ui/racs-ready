# Daily attendance and payment viewing

## Resolution Center

All queue pages contain at most 10 records. The server fixes the page size at
10, so a larger query parameter cannot bypass it. Counts and filters continue
to apply to the complete queue before pagination.

## Daily staff attendance

The staff attendance page accepts a work date, including a notification link's
`?date=YYYY-MM-DD`. It lists active technicians and secretaries employed by that
date, including staff with no saved attendance record. Check-in, check-out and
missing-time warnings are separate columns. Earlier dates are view-only; the
existing recorded attendance history remains available for payroll review.

The daily roster uses eight batched, projected reads and does not change staff
availability, attendance or payroll while loading. Leave, technician rest days,
saved working days and global non-working dates are respected. Before the
check-in cutoff, a missing scan is shown as “Not checked in”, rather than an
early absence.

Missing-time alerts run every five minutes after server startup and inspect
today and yesterday in Philippine time. The check-in cutoff is 9:00 AM, or the
saved shift start if it is later. Check-out uses the technician's saved workday
end or secretary's saved shift; the fallback is 6:00 PM, matching the company's
default public closing time. Overnight shifts keep their next-day end time.

The admin receives a notice linking to the affected daily roster. The staff
member receives a private notice addressed to their User account. Alerts do
not check someone out, block work, change salary or create absence records.
Historical reminders ask the staff member to contact the admin rather than
recording yesterday's time through today's scan page.

`Notification.attendanceAlertKey` has a sparse unique index. Each date, staff,
issue and recipient combination is inserted once. The worker ensures the index
exists before running, prevents overlapping cycles and retries failed saves.
Other technicians cannot read a personal attendance reminder through the inbox.

## Project payments

Project payment viewing is read-only. It resolves the source booking's MongoDB
payment-proof file, legacy project evidence, and receipts from payment ledger
records linked to the project or source booking. The modal shows originals
without file inputs or save controls.

The legacy project payment-snapshot update endpoint returns
`409 PAYMENT_LEDGER_REQUIRED`; it cannot replace proof or set a project paid
outside payment review and collection. Project proof uploading is restricted to
the assigned project lead technician through the existing collection workflow.

## Expense receipts

The shared receipt viewer displays authenticated image and PDF previews, opens
the full file, clears old previews and revokes temporary URLs. Missing files
show an explanation and a retry button. Protected routes remain authenticated;
receipts are not made public to fix viewing.

New technician expense receipts are signature-checked and saved in MongoDB
GridFS (`financialReceipts`) rather than the application container's filesystem.
The protected `/api/receipts/:id` route permits admins, secretaries and the
uploading technician, and returns private, non-cacheable content.

For old receipt URLs, `node server/scripts/recoverExpenseReceipts.js` performs
a dry run. Run it in the Dokploy application container, where original upload
files or restored backup files are available. `--apply` copies existing,
signature-checked originals into GridFS, retaining the technician account,
original URL, and a SHA-256 checksum. It skips saved copies and reports missing
or invalid originals. It never edits expense amounts, status, approval or
receipt references. The protected legacy URL now redirects to its recovered
MongoDB file, so repair purchase references and existing expense links remain
valid. To recover a missing original, restore that exact photo to
`server/public/uploads/expense-receipts` first; a filename alone cannot restore
its contents. The new application code must be deployed for these routes and
commands to be available.

Read-only investigation of the configured database found four expense receipt
paths: one file exists locally and three are missing from this computer. Those
three files cannot be recreated from their paths. Recover the original files
from the deployed server's `server/public/uploads/expense-receipts` directory
or the original submitter. No receipts or business records were changed during
the diagnostic. `node server/scripts/diagnoseSavedReceipts.js` reports counts
without printing credentials or receipt contents.

## Verification

The October 12 roster mismatch was reproduced with the exact database filter:
it returned only Test Tech and Raymark Mallari. Seven other active technician
profiles had `createdAt: {}` instead of a BSON date, so MongoDB's date comparison
excluded them. Attendance now reads active, unarchived staff and evaluates the
selected date after normalizing valid dates. For legacy missing or malformed
dates, the profile ObjectId timestamp is the fallback. Staff created after the
selected day remain excluded, and no stored dates are rewritten.

An isolated read-only run of the actual roster service confirmed nine
technicians and six secretaries for October 12. The diagnostic disables index
and collection creation and does not start application workers. Seventeen
attendance checks pass, including imported profiles, accounts without sign-in
access, future staff exclusions, roster display, shift rules and private alerts.

Focused automated checks cover ten-record pagination, real date validation,
shift ends, overtime, overnight shifts, leave and rest-day exclusions, complete
and missing daily records, notification deduplication and retry, private
recipients, read-only payment viewing, proof reference fallbacks, file signature
validation, protected receipt delivery, photo/PDF rendering and missing files.
QR security, manual attendance rules, payroll approval and resolution action
guards are checked alongside these changes. No live cancellations, payments,
attendance changes or notifications were submitted as tests.
