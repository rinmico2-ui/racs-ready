# Payment review before resolving a case

The Resolution Center keeps rescheduling, reassignment, replacement visits and case closure unavailable until the payment arrangement has been reviewed. The same checks run on the booking and order mutation endpoints.

For online full payments and deposits, use **Review payment** to inspect the submitted receipt and verify the actual payment. A verified deposit is sufficient; the remaining balance can still be collected after service. When no valid payment submission exists, resolution stays blocked while staff addresses the submission through the normal booking or order payment workflow.

For **100% Cash After Service** bookings and **Cash at Pickup** orders, use **Confirm cash arrangement**. Staff confirms the customer, booking details, amount due and agreement to pay in cash. This saves a separate approval with the staff member and time. It creates no payment, records no money received, and does not change payment status to paid. Normal approval of a new Cash After Service booking records this confirmation too.

Cash approval covers the current payment method and total. A changed amount or method requires another review. A stale or concurrent confirmation is rejected. Confirming terms on an overdue case keeps its current schedule and status so staff can resolve the actual scheduling issue afterward.

Existing completed or cancelled work can still be reviewed. Staff never needs to invent a payment to close its historical case.
