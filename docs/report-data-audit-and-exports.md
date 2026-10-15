# Report data audit and downloads

Reports now use Philippine calendar days independently of the server timezone.
Creation-based Service and Order reports describe the selected booking cohort.
Sales and Payments recognizes work on completion and payments/refunds on their
actual event dates. Customer Activity counts completed customer transactions.
These measures answer different questions and should not be expected to match
when work is completed or refunded in a later reporting period.

Corrections include completed product-return refunds, approved mixed repair/core
charges, per-transaction unpaid balances, active HVAC variants in stock reports,
reservation-aware stock alerts, and canonical completed booking/order technician
reviews. Archived and explicitly excluded test records are omitted. Pending
refund requests do not count as returned money. Rating a completed transaction
preserves its legacy completion-date fallback.

The stock reorder and idle-stock totals cover all matching items; the displayed
recommendations remain a short list. Stock cover uses observed usage. Missing
historical completion dates or costs remain data-quality findings rather than
invented dates or costs. A negative net sales result can be valid when refunds
for older transactions exceed sales completed in the selected dates.

## Download reports

Use **Download CSV** on Report Center, Sales and Payments, Service Reports,
Order Reports, Stock Reports, Customer Activity, Customer Ratings, and Technician
Ratings. Downloads use the selected server-side filters. The report-summary CSV
uses columns `Report, Section, Record, Metric, Value`, including KPIs, chart
series, and the report's detail summaries. Detail lists retain the limits shown
in the report; this is not a full database export. Customer Activity and Customer
Ratings provide table-oriented CSV. CSV exports include UTF-8 encoding, quoted
fields, and spreadsheet-formula escaping. Exports exceeding 50,000 output rows
are rejected with a request to narrow the selection; they are not truncated.

In the customer's **My Bookings → View Details**, **Download PDF** replaces the
raw JSON download. It contains the customer's booking, services, schedule, and
payment summary. It is a booking summary, not an official receipt. The server
enforces ownership and excludes internal notes and evidence.

## Check the deployed data without changing it

The workspace cannot connect to the private production MongoDB. After deploying
the changes, open the **web application's terminal** in Dokploy and run:

```bash
cd /app
node server/scripts/audit-report-data.js --from=2026-10-01 --to=2026-10-15
```

Omit both dates to inspect the current Philippine month. The command has no
write/apply mode and disables automatic index and collection creation. It prints
aggregate totals, data-quality counts, and reconciliation differences without
customer names, contact details, credentials, or individual database records.
Reads are capped at 50,000 documents per collection and time out after 30 seconds.
If that limit is exceeded, it stops instead of reporting partial totals. Reads
across collections are not an atomic snapshot: new activity during an audit can
create small reconciliation differences. Run during a quiet period and rerun
before treating a difference as a data fault.

Check `reconciliation.matches`, the three reconciliation differences, and
`findings`. Legacy dates, missing saved costs, orphan payments/reviews, excessive
reservations, or duplicate reviews require checking original business records.
This command does not delete, repair, or change financial or stock records.

## Comparing the Sales and Payments tabs

Sales charts and their detail rows now use completed work in the selected dates.
Their source totals add up to sales before refunds. The displayed reconciliation
then deducts completed period refunds to reach the Completed sales card.

Collections lists actual payment/refund events and separates money for completed,
unfinished, older, cancelled, archived, or missing work. Payments linked to missing
bookings remain recorded cash; they require review rather than automatic deletion
or invented replacement bookings. A payment label of `paid` is not used to invent
missing payment-ledger entries.

The payment coverage percentage is the amount applied to the requested work divided
by its value. The requested-work value equals applied payments plus unpaid balances.
Each order or booking is settled separately, so another transaction's overpayment
cannot hide its balance. This percentage is separate from period cash received.

Activity provides Completed sales, Payments and refunds, New requests and counter
sales, and Unmatched payments. All totals cover the full selected view; 25 rows are
shown per page. Chart details use the same event dates and amounts as their charts.
Product item totals are reconciled with order fees and counter adjustments; walk-in
aircon orders are included. Service detail costs include local purchases as well
as parts, supplies, and actual labor. Profit is an estimate based on saved costs.

The audit's `reconciliation.matches` means its arithmetic agrees with the report.
It does not certify that every source record is intact. Inspect `dataQuality`,
`findings`, and the new aggregate `explanation` cash groups. Historical orphan counts
can exceed the unmatched-payment count within a selected date range. Run the audit
with the same start and end dates shown in the report when comparing totals.
