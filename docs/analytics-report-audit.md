# Admin and secretary report audit

## What the report library answers

| Management question | Existing source of record | Decision report |
| --- | --- | --- |
| Recognized revenue, collections, refunds, outstanding balances | Revenue Intelligence, backed by `enterpriseRevenue` and payment ledgers | Links to the financial report; does not restate cohort value as recognized revenue. |
| Service delivery and recorded direct costs | Service Performance and `serviceCostAnalytics` | Ranks service and unit combinations by bookings, completions, cancellations, recent activity, and stored completed cohort value. |
| Product sales and stock exposure | Completed `Order` and `WalkInSale` items; Inventory Controls | Combines the same SKU across channels, separates sales from completed-service parts use, and shows stock cover and movement. |
| Customer activity and loyalty | Customer accounts, completed booking/order cohorts, `SiteSetting` policy | Shows activity segments, a documented score, and qualification candidates. |

## Findings corrected

- The report library was shared by admin and secretary, but Management Decisions was admin-only. Both roles now have a read route under their own prefix; secretary access requires `reports.view`. Policy changes remain admin-only.
- Order item grouping could count the same order twice for a repeated SKU. It now counts distinct orders per SKU.
- Counter sales could split one SKU by display name or type, and online and counter sales could appear as separate aircon decisions. Item rows are now grouped by SKU and combined before stock advice.
- Parts use could include unfinished or cancelled service jobs. The decision report now uses non-voided usage tied to completed services and excludes order-linked installation projections.
- A low-stock flag alone could suggest replenishment for items with weak demand. Suggestions now use demand, observed stock cover, current stock, and available margin evidence. Slow stock can instead prompt a purchasing hold or promotion review.
- A top-seller-only product cap could make omitted sold SKUs appear to have no demand. Aggregations now retain grouped SKU results before display selection, and display selection keeps the leading exceptions, best sellers, and slowest movers.
- Revenue Intelligence now shows the least sold POS products by units within its filtered completed-sale cohort. Service Performance shows the least booked services within its filtered booking cohort. Both link to Management Decisions for catalog entries with no observed activity.
- The admin dashboard now loads a Management Focus section from the authorized decision report when it comes into view. It shows actual service, aircon, parts-use, and loyalty signals with supporting action evidence; the secretary dashboard remains scoped to operations.
- The dashboard financial fallback previously added accepted payments to completed booking values, which could double count business activity when the authoritative revenue engine failed. The dashboard now marks the financial snapshot unavailable in that case. Aircon stock value uses recorded unit cost and reports cost coverage, and the highest stock-value list is labeled accordingly.

## Interpretation limits

- The decision report's service unit values come from booking prices, with multi-line booking value divided between lines. They are cohort comparisons, not line-level recognized revenue or unit-level profit.
- Online order items have no historical cost snapshot, so item contribution estimates use current catalog cost. Completed item refunds are shown in aggregate because they cannot reliably be allocated to each item in this view. Use Revenue Intelligence for financial totals.
- Stock cover uses observed movement in the selected period. There is no supplier lead time, purchase order pipeline, seasonality forecast, or automatic purchasing decision in the action rule.
- The customer cohort currently reads up to 10,000 customer accounts. The page flags this cap. A complete large-scale customer ranking would need a paginated database aggregation.
- Loyalty tiers are a qualification preview. There is no centralized, auditable checkout discount snapshot across bookings, orders, and counter sales; the configured percentage is not applied to prices.

Focused automated checks cover role wiring, report template rendering, product recommendations, SKU merging, and existing report center behavior. Live database totals still require comparison against a populated environment before management uses the report for purchasing decisions.
