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
