# Customer booking cancellation

Standard core, repair and mixed service bookings use the same cancellation request flow in Book History. Linked purchase installations, projects and maintenance retain their own lifecycle rules.

- Before work starts, an unpaid booking without a technician or active assignment can be cancelled immediately. Expected deposits do not count as received money.
- A submitted payment, received money or existing technician assignment requires staff review. Pending payment verification does not prevent the customer from sending the request.
- Pending and under-review requests appear as **Customer cancellation** in the Resolution Center, including future appointments. The notification links to that exact booking and opens its request.
- New assignment, acceptance, service edits and visit execution are blocked during review. Existing payment verification remains available.
- Staff can start review, decline with a customer-facing explanation, or approve cancellation. Approval requires reconciling pending submissions and received money first. Cash after service does not require pretending that a payment was received.
- Approval cancels active assignments and keeps booking and service history. Reserved equipment is released through the existing lifecycle; equipment already issued remains in technician custody until returned.
- Full or partial refunds are allocated across received payments and queued as pending. Existing payment processing completes each refund separately. Booking refund progress remains incomplete until every approved refund has been processed.
- Customers see the request, public history, staff decision and refund progress. **Ask for Review** appends an appeal to the same request, with a new revision.

Customer endpoints require authentication and ownership. Staff reads require appointment and payment visibility; approval additionally requires payment management. Request ID and revision guard against decisions on an older appeal. Submission and decisions use transactions and the appointment date lease shared with assignment.

Focused coverage is in `server/tests/customer-cancellation.test.js`, with queue, assignment, presentation and navigation regressions in their existing test files. Tests use synthetic records and do not write live bookings or send notifications.
