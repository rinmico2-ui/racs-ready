# Seed historical service bookings and aircon orders

This is the owner-requested demonstration batch for the live Dokploy database. It **adds records** and preserves existing transactions, customers, staff, stock, payroll, expenses, POS sales, uploads and audit history. It is never called during application startup or deployment.

## What the default batch contains

| Main transaction | Completed | Cancelled | Total |
| --- | ---: | ---: | ---: |
| Service bookings | 400 | 100 | 500 |
| Aircon orders | 400 | 100 | 500 |
| Total | 800 | 200 | 1,000 |

The operational dates cover January 2022 through October 15, 2026, in Asia/Manila. Creation, cancellation, payment and completion dates remain historical and chronological. Each cancellation has an explicit business-scenario reason. Cancelled records have no fabricated collection or refund.

The 500 service bookings include Core and Repair. Orders cover pickup, delivery, and delivery with installation. Installation orders also receive their linked booking mirrors: these are supporting records, not additional independent sales. The database therefore receives more than 1,000 documents. Completed service assignments, approved service reports and payment ledgers are linked to their parents. The preview gives exact collection counts and per-year totals.

Every new transaction has a `DEMO-` reference and a `demonstration.batch` marker. Reports include this batch, so the resulting sales and profit are **demonstration totals**, not evidence of actual historical income. Prices and buying costs are snapshots of the existing catalog, not reconstructed 2022–2026 price history. Service labor costs are explicitly simulated at 25% of the service value. The existing payroll, POS and expense records still affect reports.

No stock quantities, reservations, equipment custody, serial registries or balances outside this batch are changed. No receipt, customer signature, physical serial number or proof photo is invented. Simulated cash ledgers are marked as demonstration records; no payment provider is contacted.

## Existing Gmail accounts only

Customer IDs and email snapshots come from existing customer accounts. Eligible accounts must:

- Have an address at `gmail.com`, `role: customer`, and `emailVerified: true`.
- Have an email-verification timestamp or a linked Google identity as verification evidence.
- Be active, unblocked, unarchived and past the account-invitation stage.

The script does not create accounts, change addresses, reset passwords, or mark unverified customers as verified. A Gmail-shaped string or a legacy default verification flag alone is insufficient. It also requires an active technician linked to an active technician user account and existing priced service, repair and product catalogs. Buying costs must be recorded and positive for eligible aircon products.

This batch is visible in the selected accounts' histories. It sends **zero emails and zero customer notifications**. Demonstration work is excluded from real loyalty rewards, automatic aftercare assets/reminders, warranty requests and product returns/refunds.

## Schema audit

The tool reads every JavaScript file in `server/models`, loads every exported Mongoose model, traverses embedded schemas, and records required fields, types, enums, references and indexes. At implementation the project contained **71 model files and 69 exported models**. Every generated record then passes the real model's validation, including the booking appliance-count validator. The private prepared file records the schema fingerprint; application refuses a prepared seed if schemas have changed.

| Area reviewed | Seed behavior |
| --- | --- |
| BookingService, Order, Assignment, ServiceReport, Payment | Insert validated, linked terminal records; check amounts and installation back-references. |
| User, Technician, CoreService, RepairService, ServiceCategory, Inventory, HVACProduct, Brand | Reuse eligible existing identities and catalog data; preserve all existing documents. Category-based repair uses its real category/unit-type catalog rather than inventing a RepairService ID. |
| Project, work-order, daily-assignment, daily-kit, stock, equipment and parts workflows | No unfinished project or physical custody is created. The requested seed consists of standard historical service bookings and orders. |
| Aftercare, warranties, product returns, ratings, notifications, email outbox and authentication | No fabricated reviews, claims, messages, login records, credentials or benefits. |
| Payroll, attendance, compensation, expenses, POS, configuration and audit models | Preserve existing records; add only the batch completion marker and an audit event after successful atomic verification. |

To inspect the full schema inventory without connecting to a database:

```sh
node server/scripts/seed-transaction-history.js --schema-audit
```

## Run inside the Dokploy web-application terminal

Wait until the deployment containing this script has succeeded, then open a **new application terminal**. Docker/server-terminal access is unnecessary. Keep MongoDB private.

1. Preview the batch without writing files or data:

   ```sh
   cd /app
   node server/scripts/seed-transaction-history.js
   ```

   Expect `mode: dry-run`, 1,000 primary transactions, the split above, reconciled simulated sales/payments, zero physical stock changes and `databaseChanges: 0`. A `blocked` result explains missing eligible accounts, staff or catalog prices. Resolve the actual issue; do not invent verification evidence.

2. Prepare the private seed file, still without changing database records:

   ```sh
   node server/scripts/seed-transaction-history.js --prepare
   ```

   Expect `mode: prepared` and `recoveryVerified: true`. In your authenticated admin browser, download the two addresses printed as `backupDownloadPath` and `checksumDownloadPath`. Keep them private. These contain the exact planned records and the eligible source snapshots; they are not a full production-database backup. Download them before a container replacement can discard `/app/temp`.

3. Copy the **exact `backup` path from that output** into this command:

   ```sh
   node server/scripts/seed-transaction-history.js --apply --backup /app/temp/transaction-history-seed-REPLACE-WITH-THE-PRINTED-FILENAME.ejson.gz
   ```

   Expect `mode: seeded`, `atomic: true`, and `reconciliation.matches: true`. All five transaction collections, the batch marker, and the audit event commit together. A failed write aborts the entire insertion. There is no standalone-server fallback.

4. Verify using the same path:

   ```sh
   node server/scripts/seed-transaction-history.js --verify --backup /app/temp/transaction-history-seed-REPLACE-WITH-THE-PRINTED-FILENAME.ejson.gz
   ```

   Expect `mode: verified`. Allow 30 seconds for report caches, then refresh the reports and select the desired historical period. The existing report range limit permits a January 2022–October 2026 custom range.

Maintenance mode is not changed or required: this is an atomic insertion of terminal demonstration records. The script rechecks eligible accounts, staff and catalog snapshots immediately before writing. If these change after preparation or the preparation is over 24 hours old, prepare a fresh file.

## Repeat runs

The default batch key is `history-demo-2022-2026-v1`. Its IDs are deterministic and a unique completion marker prevents a second insertion. A repeated preview reports `already-applied`; a repeated apply verifies the existing batch and does not write another copy. Verification fails if seeded records have subsequently changed, rather than overwriting them or adding replacements.

Changing the batch key intentionally creates an additional batch. Do not change it just to get past an error. This tool never runs the older booking/order deletion or reset scripts.

## Verification field-order fix

The original verifier could report `Seed verification failed: bookingservices changed or is incomplete.` because MongoDB places `_id` first in stored documents. The corrected verifier compares field-order-independent Extended JSON while retaining exact value, type, date, reference, array order and record-count checks. The private recovery-file and source-snapshot checksums retain their original format.

This error is raised inside the transaction before commit, so the failed insertion is aborted. After deploying the fix, open a new application terminal and run `--prepare` again. Download the new preparation and checksum, then apply and verify using that new exact path. Keep the default batch key: it prevents a second insertion if the batch is already present. Do not delete existing transactions or disable verification to retry.
