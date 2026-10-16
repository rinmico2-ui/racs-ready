# Payment and revenue reconciliation

The payment ledger and revenue report answer different questions. Select the same Philippine date range before comparing them.

| View | Basis |
| --- | --- |
| Payments received | Accepted Payment amounts on their collection date, including money still held by technicians. Pending proofs and failed payments contribute zero. |
| Payments after refunds | Collections minus completed refunds dated in the selected period. Refund requests contribute zero. |
| Completed sales | Services and orders completed in the selected period, plus completed POS counter sales, less completed period refunds. |
| Unpaid balance | Work requested in the selected period, less dated payments applied to that specific work. |
| Service profit | Completed service charges after applicable period refunds, less saved internal job costs and project materials. |
| Profit after expenses | Completed sales after period refunds, less saved direct costs, approved operating expenses, and approved/paid gross payroll. |

The Payments page contains the Payment ledger. Independent `WalkInSale` counter checkouts do not create Payment rows; their receipts and collections are added separately by the revenue report. Order installation mirrors must be counted with their order once.

Payment details resolve descriptions from `BookingService.issueDescription`, `unitInfo.problemDescription`, legacy `repairIssues`, and repair service lines. Collection notes, the collector, date, and payment status are shown separately. An order total or deposit never replaces the amount on the individual payment record. Project-only payments resolve their project’s booking.

The paged Payments endpoint (`view=ledger`) streams narrow metadata to calculate totals across all matching records. It excludes image/signature payloads and does not silently stop at 1,000 records. Search and filters apply before pagination. Technician collections retain the existing remittance review workflow.

Service allocations use updated core charges and approved repair quotations. Customer-purchased items do not become company purchase costs. Saved product costs remain historical snapshots; older rows without snapshots retain the existing catalog fallback and missing-cost disclosures.

## Live read-only verification

After deployment, in the Dokploy application terminal:

```sh
cd /app
node server/scripts/audit-report-data.js --from=2026-10-01 --to=2026-10-16
```

Use the dates selected in the report. Share aggregate JSON only, never backup contents, customer records, or credentials.

`reconciliation.matches` checks the independent audit against the revenue engine. `tabConsistency.matches` checks activity, monthly totals, service allocations, itemized costs, and profit arithmetic. Historical data-quality findings still require review even when both arithmetic checks pass. A failed audit prints a safe stage and error type, without connection details. It makes no database changes.

Automated tests use synthetic records. They do not establish the correctness of live historical records until this audit succeeds and its findings are reviewed.
