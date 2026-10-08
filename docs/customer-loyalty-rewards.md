# Customer loyalty discounts

## Admin configuration

Open **Admin → Customer Privileges**, `/admin/customers/privileges`.

1. Add a named rule.
2. Choose completed service bookings, product orders, or both as the qualifying activity.
3. Edit **Completed transactions required** and **Discount percentage**.
4. Choose services, aircon products, or both as the reward channel.
5. Optionally select which booked services count and which items receive the discount. Empty lists mean all eligible items.
6. Activate the rule, enable automatic loyalty discounts, and save.

Example: after five completed cleaning bookings, give 10% off future standard cleaning bookings. Select Cleaning under both qualifying services and discounted services. The fifth booking earns eligibility for the next checkout; it does not discount itself retroactively.

The program starts disabled and no rules are invented or enabled automatically. Up to 12 rules can be configured, with 1–10,000 completions and 0.01–50% discounts. Saving checks the previous revision to prevent overwriting another administrator's changes. Rule updates are audited. Customer Performance and Management Decisions use these same active rules; the former analytics-only policy editor has been replaced with a link to Customer Privileges.

## Qualification and supported checkout

- Qualification is lifetime activity, independent of report dates. Multi-unit bookings count once.
- Pending, cancelled, fully refunded transactions and order-linked installation bookings do not add a completion. Reverse `Order.bookingId` links are checked for older installation records.
- A completed order whose entire net product value was refunded does not qualify, even if a transport charge remains.
- Earned benefits continue while the applicable rule is enabled. They are membership discounts, not one-use coupons. The best monetary discount wins; rules do not stack.
- The Services customer checkout, cart order checkout, and direct Buy Now checkout show the server-calculated reward before payment. Eligible service and product prices come from the catalog.
- Transport and travel fees, repair inspections and later repair quotations, accepted unit-assistance/custom quotations, and large project bookings are excluded from automatic discounts.
- Account-linked counter orders contribute to lifetime order qualification. Staff POS creation retains its existing manual discount workflow; automatic rewards are applied in the customer checkout flows above. Anonymous counter sales cannot earn account-based rewards.
- Existing bookings and orders retain their applied rule/revision snapshot after policy edits. A booking scope change cannot move its discount onto a different service or onto inspection/travel fees; removing its eligible services caps or removes the recorded discount.

## Pricing, payment, returns, and reporting

The server signs a customer-bound checkout quote lasting 15 minutes and rechecks the catalog, completion history, and active rule at submission. Changed, expired, forged, or cross-customer quotes return 409 for review. Clients cannot supply discount amounts. A missing quote is permitted only when no reward applies.

Bookings record the reward snapshot and net service total. Orders record the reward snapshot, net order total, and discount allocations on eligible product items. Allocations reconcile to the cent, including when a reward only covers selected products. Item returns use those recorded net prices. Historical manual discounts retain proportional allocation behavior.

Downpayments follow the existing whole-peso payment policy, calculated from the discounted total plus applicable transport/travel. Consumable, parts, and labor costs retain their recorded amounts; discounts lower revenue and therefore contribution. Reporting reads net transaction/item values and keeps discounts separate in customer history. Historical inventory costs remain subject to the reports' existing cost-coverage limitations.

## Verification

`node --test server/tests/loyalty-rewards.test.js` covers policy bounds and concurrent edits, completed-count rules, item scopes, best-reward selection, signed-quote tampering and expiry, stable booking pricing, payment totals, item returns, cent allocation, and checkout template syntax. Existing checkout, return, customer-performance, service-payment, and order analytics tests cover the affected workflows.

`node server/scripts/checkCustomerPerformance.js` runs read-only checks against configured MongoDB, with automatic index creation disabled. It verifies customer totals, paginated records, and financial expressions using temporary inline fixtures; it does not save a rule or change any booking, order, payment, or customer. Loyalty rule qualification is covered by `loyalty-rewards.test.js`.
