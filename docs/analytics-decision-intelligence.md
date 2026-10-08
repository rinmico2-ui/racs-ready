# Management Decisions data contract

The Management Decisions report answers demand and action questions for admins and secretaries with `reports.view` using existing records. It does not create a second financial ledger.

| Question | Source | Reporting rule |
| --- | --- | --- |
| Service and unit demand | `BookingService.services[]`, fallback `BookingService.service` | Booking creation cohort; order-linked installation projections excluded; completed and cancelled counts remain separate. Active `CoreService` and `RepairService` catalog entries with no bookings are included. |
| Aircon sold | Completed `Order.items[]` and completed `WalkInSale.items[]` | Item quantity and item price; order and counter-sale discounts allocated by item share of subtotal. Pending and cancelled sales excluded. |
| Tools and parts sold | Completed `WalkInSale.items[]` | Snapshot item quantity, price, cost, and discount. Operational assets with no sale are excluded from slow-seller judgments. |
| Parts consumed | Non-voided `ServiceToolUsage` linked to completed, non-order-installation `BookingService` records | Usage quantity and completed-service count are displayed separately from sales and never counted as sales revenue. |
| Product contribution | Completed sale item price less allocated discount and available unit cost | Order items have no historical cost snapshot, so their current inventory cost is an estimate. Counter-sale items have cost snapshots. Completed item refunds are displayed separately and are not silently allocated to item margins. |
| Customer activity | `BookingService.customerId`, `Order.userId`, `User` | Selected booking/order creation cohort, using current completion state. Only completed values count toward spend and loyalty qualification. Lifetime completed activity distinguishes inactive customers from customers who have never transacted. Anonymous POS customers are not linked by name or phone. |
| Loyalty qualification | `SiteSetting.customerLoyaltyRewards` | Active Customer Privileges rules use lifetime completed bookings/orders, excluding full refunds and linked installations. Report dates do not reset qualification. Eligible customer checkout applies the best monetary reward. |

Use Revenue Intelligence for recognized revenue, accepted collections, refunds, outstanding balances, and project-aware service pricing. The Management Decisions service value column is **completed booking cohort value** from stored prices, not recognized revenue. The decision report never changes transaction prices, inventory, or customer balances.

The product action queue combines observed sold units and completed-service consumption only to estimate stock pressure. It keeps sales demand and service-use demand separate in the table. For a period of at least 30 days, an item with low or no demand and stock on hand is flagged to hold purchasing when there is no observed movement or at least 60 days of stock at the observed run rate. Items with high or medium demand and stock at the reorder level or under 15 days of cover are flagged to restock soon; a part or consumable at seven days of cover or less is flagged to restock now. These are review suggestions based on a simple period run rate, not purchase orders or forecasts. Provisional margin is shown alongside the recommendation and is never described as net profit.

Service demand needs at least 10 booking-line observations and 14 days before it assigns a strength label. High demand needs at least three bookings, two completed bookings, recent-half activity, and at least 20% of either bookings or completed cohort value. Medium demand needs two bookings, one completion, and at least 6% of bookings or value. Other observed services are low demand; zero bookings are reported separately. This avoids calling a busy but entirely uncompleted service a strong performer.

## Loyalty discounts and remaining cost gaps

Bookings and orders now record the applied loyalty rule, policy revision, qualifying count, eligible base, rate, and amount. Orders also retain item-level discount amounts for scoped rewards and product returns. Admins edit rules in Customer Privileges; this report reads the same active rules. Customer checkout applies automatic rewards to eligible service/product prices. Staff POS retains its manual discount workflow. See [customer-loyalty-rewards.md](customer-loyalty-rewards.md) for qualification, payment, refund, and scope details. Order items still lack historical cost snapshots, so the existing inventory-cost estimates remain provisional.

## Performance and access

Transaction questions use date-bounded MongoDB aggregation and return grouped rows. The report response is cached briefly. Lifetime customer activity is cached for five minutes; loyalty history is read in bulk for the report and rechecked directly at checkout. Display details are limited to 30 customer rows and 50 rows per product group. The customer account cohort is capped at 10,000 and the UI flags when the cap is reached; this is a scale limit, not a complete customer export. Admins and secretaries with `reports.view` can read the report through their own page and API routes. Only admins can change discount rules in Customer Privileges; report readers cannot edit them.
