# Cancellation when an original inventory item was removed

The read-only check for ORD-20260827-REGG found a `preparing_unit`
delivery/installation order with a received PHP 2,793 partial payment. Its
original HVAC variant ID could not be found in either the HVAC catalog or
legacy inventory. The cancellation route treated a missing stock entry as a
fatal error, rolling back cancellation and refund review.

Cancellation now restores only the exact original inventory IDs. A removed
item is recorded in the order's `cancellationStockReview` rather than matched
to another product by name or HP. Available lines still return to their own
stock records. Real database errors and invalid quantities abort the whole
transaction. The cancelled status, received-payment refund request, linked
booking cancellation and stock changes remain in the same transaction.

The status audit and staff stock-review notification run after commit. Admin
and secretary see the affected item names, quantities and original stock IDs
in order details; the Resolution Center acknowledges the stock issue after
a successful cancellation. The notification opens the order details. Staff
must check the physical units and inventory before making a stock adjustment.
The internal stock-review field is excluded from queries by default and is
only selected for staff order details; customer cancellation responses omit
it and the staff warning. Unverified receipts do not become payable refunds.

No actual order cancellation or inventory adjustment was performed during
verification. Tests use mocked database operations and sessions.

Regression checks: `order-cancellation-stock.test.js`,
`order-action-errors.test.js`, `order-refund-request.test.js`,
`resolution-action-loading.test.js`, `resolution-order-review.test.js`,
and `admin-order-modal-ui.test.js`.
