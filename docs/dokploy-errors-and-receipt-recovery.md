# Dokploy error fixes and expense receipt recovery

15 October 2026, Asia/Manila. These changes are local and require an updated deployment. No production records, receipts, notifications or emails were changed during verification.

## Fixed application errors

The product detail route now rejects malformed IDs before querying HVACProduct and responds with a normal Product Not Found page. This covers the literal `${safeCheckoutImageUrl(inv.imageUrl)}` and long numeric IDs in the pasted logs. The template interpolation remains valid inside the checkout's JavaScript; the logs do not establish whether a crawler extracted that source text or another client constructed the malformed URL.

Existing technician records with malformed `createdAt` dates recover a date from their ObjectId when next saved, including the case where Mongoose supplies a default date but retains a casting error from hydration. Valid dates remain intact. Newly submitted invalid dates and enum values still fail validation.

The assignment acceptance expiry worker now starts after database readiness, uses an atomic pending-assignment claim and a shared per-assignment lease, and processes each failure independently. It retries previously expired assignments whose cleanup was interrupted. It returns the current booking to the administrator queue, preserves newer booking assignments, and resolves technician availability from attendance/leave while retaining other active assignments. It records successful cleanup and avoids duplicating expiry notifications on a retry. No automatic technician reassignment was added.

## The reported receipt

The browser requested:

```text
/uploads/expense-receipts/expense-1791720667223-710232883.jpg
```

The server returned 404. The exact file is also absent from this local project's receipt folder. Three other local receipt files exist, but they are not replacements for this receipt. A path in an expense record does not contain the original image bytes. The source may have been lost from a container filesystem during redeployment; server volumes/backups are needed to establish what happened.

## Restore the genuine original after deploying

1. Obtain the original JPG/PNG/WEBP/PDF from the submitter, an old server upload volume or a file backup. Do not use a screenshot of a different receipt or a database dump that lacks the original file's bytes.
2. Sign in as an **administrator** and open **Appointments → Expenses → View details** for the affected expense.
3. When its receipt reports that the file is missing, the new **Restore original receipt** form appears below the preview. Read-only staff do not see this form and cannot call its restoration endpoint.
4. Choose the original file, at most **5 MB**, confirm that it belongs to this expense, and click **Restore original receipt**.
5. The preview reloads and the old saved link resolves to the recovered file. **Open full photo/Open PDF** uses the protected saved URL rather than a temporary preview URL.

Restored originals are stored in MongoDB GridFS with the original owner, restoring administrator, time, expense ID and file hash. The application also records `expense.receipt.restore` in its audit log. Upload retries reuse the recovered file. Expense amounts, approval state, linked purchase records and existing receipt references are preserved. File signature checks and private download permissions remain enforced. A file that already exists is not overwritten.

For multiple legacy uploads found on the server or in an old volume, the existing recovery script supports a dry-run first:

```sh
node server/scripts/recoverExpenseReceipts.js
```

After original files have been placed under the application's `server/public/uploads/expense-receipts` folder and the dry run reports `ready` for the matching files, import them into GridFS:

```sh
node server/scripts/recoverExpenseReceipts.js --apply
```

This script imports originals without rewriting financial records. `missing_original` means the image still needs to be retrieved from a backup or the submitter. Do not restore an entire old production database simply to recover one receipt. Keep GridFS covered by database backups; see [the Dokploy security guide](dokploy-security-steps.md) and [backup storage setup](dokploy-backup-storage-setup.md).

## Verification

Twenty-six new regression tests cover malformed IDs, real Mongoose technician validation/save hooks, interrupted expiry processing, availability, receipt restoration, concurrent retries, original owner/audit metadata, real multipart HTTP upload, private alias delivery, and preview failure handling. The full suite passed **2,131 tests with zero failures**. Isolated Edge browser checks passed at **1440px and 390px** for opening an expense, reporting its missing receipt, restoring a synthetic original, following the protected redirect, displaying the image, and hiding restoration from secretary users. No production credentials or financial data were used.

The receipt preview also times out after 15 seconds instead of waiting indefinitely. Restoration is offered only for a confirmed missing-file response; permission errors and temporary server failures retain their distinct messages.
