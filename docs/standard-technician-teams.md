# Standard appointment technician teams

Admin and secretary can choose **Assign one technician** or **Assign multiple technicians** for a standard service booking or a delivery-and-installation order. Select a primary technician from the selected members. Existing technician accounts are used; no new account role is introduced.

## Assignment and execution

- Availability is checked for the entire appointment, including working hours, leave, other appointments, order installations, and confirmed project work. The server checks again when saving.
- Every selected member receives an individual acceptance request. Everyone must accept before departure. A decline or expired response requires an Operations review.
- The primary technician records job progress, shared equipment custody, payment collections, and completion. Supporting technicians see the assignment and can add work notes.
- The existing automatic daily-kit monitor includes all team members. Shared equipment and materials belong to the primary technician's kit. Supporting membership does not create another set of product or material requirements.
- Rescheduling checks every member and resets acceptance for the new visit. Continuations retain the team and require fresh acceptance. Cancelled or completed service bookings synchronize supporting assignments.
- Team membership does not multiply charges, installation bookings, payment records, quantities, or project classifications. Existing single-technician history stays compatible.

## Persistence and deployment

`BookingService.technicianId` and `Order.technicianId` remain the primary technician. Their optional `technicianTeam` arrays store membership and acceptance. Service bookings have one `Assignment` per member; supporting assignments carry zero fee. Orders retain one linked installation booking and one financial workflow.

New team writes use MongoDB transactions and a shared Manila-day capacity lease. A standalone database is rejected before invitations are created. The production database previously completed the transaction-based payroll cleanup; local fixtures do not establish the current live database configuration. No existing records need backfilling.

The model schemas declare indexes for team member, status, and appointment date. If automatic index creation is disabled in a deployment, include those indexes in its usual database index maintenance process.

## Verification

Regression coverage exercises one/multiple assignment, rollback, individual acceptance, declines, retries, rescheduling, continuations, primary-only actions, order mirrors, project conflicts, and shared kit requirements. Browser fixtures exercise admin/secretary service and order dialogs, desktop/mobile layouts, inline conflicts, and supporting-technician acceptance. Fixtures use synthetic records and do not modify the deployed database.
