# Data Lifecycle and Retention Policy

Version 1.0

## Policy

The application does not automatically hard-delete business records. Records that are no longer active remain available for operational history, reconciliation, warranty handling, dispute review, and audit traceability.

The Archive and Retention Center is available at `/admin/archive` to administrators.

## Lifecycle by data class

- Staff, products, tools, service categories, and scheduling exceptions use reversible soft archival. Archive and restore actions record the actor, timestamp, and reason.
- Bookings and project materials use cancellation. Their original identifiers and linked payments, assignments, reports, projects, and stock records remain intact.
- Tool and material usage corrections use voiding. The original usage snapshot remains intact and deducted inventory is restored once, with a stock adjustment and audit event.
- Reserved equipment uses release rather than deletion. Checkout, return, loss, and damage records are never erased by release workflows.
- Reviews use visible, flagged, or hidden moderation states. Hidden reviews are excluded from public and operational rating aggregates but retained for moderation history.
- Payroll uses voiding; payments use rejection, refund, and reconciliation states; projects and warranty claims use completed, closed, cancelled, withdrawn, or resolved states. These records are not placed in a generic deletion queue.

## Retention

Core operational, inventory-ledger, financial, payroll, warranty, moderation, and audit records have no automatic purge job. They remain retained while referenced by the system.

Security sessions, trusted devices, temporary tokens, and email delivery logs retain their separate expiry controls. The existing staff policy defines a 90-day lifetime for email delivery logs.

Any future permanent-erasure or anonymization process requires separate authorization and must validate applicable legal, accounting, tax, warranty, privacy, and contractual requirements before deployment. It must preserve financial totals and non-personal audit integrity.

## Compatibility

Legacy `DELETE` endpoints for bookings, catalogue items, tool usage, equipment reservations, project materials, and non-working days now perform the appropriate retained lifecycle transition. They do not remove the underlying business document.
