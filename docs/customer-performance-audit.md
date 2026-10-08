# Customer Performance data audit

## Page structure

`/admin/reports/customers` contains Frequent Customers, Customer Records, and Lowest Engagement. Five summaries identify customers with 5+ period transactions, the top booker, the top buyer, never-engaged customers, and formerly frequent customers who are now inactive. The tables expose actual counts and dates, with search, sorting, and pagination. There are no engagement scores, behavior matrices, or generated explanations.

View opens `/admin/reports/customers/:id` inside reporting, preserving the table filters for the return link. It shows separate selected-period and lifetime summaries, actual service and order histories, most booked services, most purchased products, a spending breakdown, and existing loyalty qualification.

## Sources reused

| Question | Source | Rule |
| --- | --- | --- |
| Accounts | `User` | Only `role: customer`. Name and email identify the account; credentials, phone numbers, addresses, and transaction photos are excluded. |
| Service use | `BookingService` | Successful completed, repair completed, or closed independent bookings. Fully refunded completions are counted separately. Both `sourceOrderId` and reverse `Order.bookingId` links exclude order installations from service counts. |
| Product use | `Order` item snapshots | Successful completed account-linked orders and their purchased quantities. Pending and cancelled orders do not count. Whole-order refunds and item refunds that exhaust product value remove the order from successful activity. |
| Refunds | Booking/order refund fields and `ProductRefund` | Recorded completed/partial transaction refunds and completed item refunds reduce completed value. `Order.productRefundAmount` mirrors are not deducted again. |
| Collections | `Payment`, `ProductRefund` | Existing accepted-payment statuses; collection/refund event dates. Each payment enters once even if both an order and booking are linked. |
| Catalog context | Existing services and HVAC products | Historic transaction snapshots preserve what was actually booked or bought. No duplicate transactions or customer records are created. |
| Loyalty | `loyaltyRewards` | Existing Customer Privileges rules, qualifying lifetime completions, tier, progress, and remaining requirement. No new scores or discounts are created. |

## Definitions

- Periods: All time (default), This month, Last 3 months, Last 6 months, This year, and Custom. Calendar boundaries use Manila time. Rolling months preserve the day of the month, clamped when the destination month is shorter.
- Period totals and ranks use successful completion dates. Dates fall back through the existing completion history, repair resolution dates, and last update for older records. All time includes legacy successful records without a known date; those show **Not recorded**, never an invented date.
- Frequent summary: at least **5 successful transactions in the selected period**. The frequent table ranks customers with at least one selected-period completion; its 5+ filter narrows the table to the summary definition. Bookings and orders have separate sorts.
- Never Engaged: zero successful lifetime bookings and orders. A separate New account label identifies accounts registered within the inactivity window.
- Very Low Engagement: 1–2 successful lifetime transactions with recent activity. Low Engagement: 3–4 with recent activity. Their actual counts remain visible.
- Inactive: prior successful activity, but no completion within the chosen 30, 60, 90, or 180 day window.
- Previously Active / Now Inactive: **5+ lifetime transactions** and no recent completion. One old booking does not earn this label.
- Recent activity uses the current report timestamp and lifetime history, independently of the analysis period. Last activity and days since activity remain explicit. Missing completion dates produce **Activity date unavailable** rather than a guessed inactivity age.
- Lowest Engagement includes customers with fewer than 5 lifetime transactions or no recent completion. This view labels its primary counts as lifetime; selected-period counts remain separately visible.
- Cancelled/declined and no-show counters use `cancelledAt` / `noShowAt`, then the legacy last update. Pending, rescheduled, cancelled, and no-show records are available through history filters and never counted as successful engagement.

## Financial interpretation

Recorded spending is completed service value plus completed order value, less recorded completed transaction/item refunds. Stored service and order totals already include discounts. Order product value uses subtotal less discounts, while order total includes delivery and installation fees. Discounts remain visible and are not subtracted twice.

Financial totals include completed transactions that were later refunded, so retained fulfillment fees remain visible even when the order no longer counts as successful customer activity. A refund adjusts the original completion cohort. Cash collections instead follow actual payment/refund dates. These are separate measures; neither is customer profit. The revenue/service/order reports remain the source for costs and contribution.

Purchased product patterns count quantities in successful completed orders, including partially refunded orders; they represent purchases, not net retained inventory. Full item refunds that exhaust product value exclude the order. Service patterns count each booking once per distinct service, even when several units were serviced. Both pattern lists show the top 20 for the analysis period.

## Query and access design

- One User aggregation joins indexed customer booking/order summaries, returning one grouped result per account to the Mongo pipeline. A facet calculates portfolio summaries, top booker/buyer, filtered total, and a maximum of **25 table rows**. Filtering, sorting, and pagination are in the database. The application no longer loads all customer rows or histories to filter them in memory.
- Aggregations reuse the existing customer-owner, linked-booking, and refund-source indexes. No migration or index-creation write is required by this refactor.
- Main payloads are cached internally for one minute. Browser responses use `private, no-store`. Profiles load details only after View, with database pagination of **20 bookings and 20 orders**. Excessive page numbers are clamped to the last available page.
- Default history filters show successful independent completions, matching the summary. Other status and date filters affect record lists only; service/product pattern lists and summary totals retain the analysis period. Clearing filters restores these defaults.
- Loyalty is evaluated only for an opened customer profile, with the existing rule engine. Main report queries do not fetch every customer's loyalty history.
- Pages remain admin only. APIs retain authentication, admin role checks, and `reports.view`. The secretary report allowlist does not expose customer financial profiles.
- Anonymous point-of-sale transactions have no reliable User link. Customer attribution is never guessed from a name or email.

## Verification

`node --test server/tests/customer-performance.test.js server/tests/customer-performance-ui.test.js server/tests/loyalty-rewards.test.js server/tests/report-center.test.js server/tests/shared-dashboard-rbac.test.js server/tests/system-sidebar-counts.test.js server/tests/work-sidebar-counts.test.js`

The UI behavior checks exercise view switching, escaped record names, currency cents, filtered return links, failed-refresh recovery, and competing asynchronous requests. They are script-level checks; a browser visual review is separate.

`node server/scripts/checkCustomerPerformance.js` performs read-only checks against configured MongoDB, disables automatic index creation, and prints only verification counts. It checks every paginated account summary, successful profile history totals, inactivity classifications, and financial expressions. Mongo `$documents` fixtures cover discounts, pending/cancelled/no-show records, partial and full refunds, and both installation link directions without writing fixture records.
