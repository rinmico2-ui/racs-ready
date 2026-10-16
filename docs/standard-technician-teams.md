# Standard appointment technician teams

Admin and secretary can choose **Assign one technician** or **Assign multiple technicians** for a standard service booking or a delivery-and-installation order. Select a primary technician from the selected members. Existing technician accounts are used; no new account role is introduced.

## Assignment and execution

- Availability is checked for the entire appointment, including working hours, leave, other appointments, order installations, and confirmed project work. The server checks again when saving.
- Every selected member receives an individual acceptance request. Everyone must accept before departure. A decline or expired response requires an Operations review.
- Waiting for Acceptance lists every member, primary/supporting role and response. Staff can extend a pending member's deadline without resetting accepted members. Returning a service team to the queue releases all current invitations together before work starts.
- The primary technician can generate and confirm AI preparation suggestions after accepting their own invitation, while teammates are still responding. This does not authorize departure or on-site work. Inspection and quotation forms unlock after Start Work and remain read-only for supporting members.
- Appliance inspections include diagnostic suggestions, technician-confirmed diagnoses and optional parts, plus a quotation draft using catalog prices and official labor fees. Suggestions never save a quotation, charge a customer or bypass staff/customer review. The existing manual form remains usable when suggestions are unavailable.
- The primary technician records job progress, shared equipment custody, payment collections, and completion. Supporting technicians see the assignment and can add work notes.
- The existing automatic daily-kit monitor includes all team members. Shared equipment and materials belong to the primary technician's kit. Supporting membership does not create another set of product or material requirements.
- Rescheduling checks every member and resets acceptance for the new visit. Continuations retain the team and require fresh acceptance. Cancelled or completed service bookings synchronize supporting assignments.
- Team membership does not multiply charges, installation bookings, payment records, quantities, or project classifications. Existing single-technician history stays compatible.
- Team assignment keeps each active service item's schedule and stage aligned with the visit. First inspections retain inspection preparation; already-approved repair visits retain phase two and their quotation parts. Core items become accepted only when the entire crew accepts. Completed items retain their recorded history.

## Persistence and deployment

AI Assist uses the company rule approved for standard jobs: two technicians for aircon installation, dismantling and relocation; one for routine service or inspection. Mixed-service jobs use the largest recommendation, and reassignment preserves a larger existing crew. These are staffing recommendations; manual assignment still permits one or multiple technicians after staff review. Customer instructions and AI-generated text cannot change the rule. Project jobs retain their project crew workflow.

Queue cards show the recommended crew and reason. Staff can assign that crew or open the manual review dialog. Bulk previews reserve every recommended member for the whole job and allow staff to change the members and primary technician. A shortage produces no partial recommendation. Confirmations and automatic reassignment use the shared transaction/availability checks; they cannot silently substitute one technician for a recommended team. A failed job in a bulk operation is reported for review; other jobs can still succeed. All members receive acceptance requests, while charges and shared kits continue to have one owner.

`BookingService.technicianId` and `Order.technicianId` remain the primary technician. Their optional `technicianTeam` arrays store membership and acceptance. Service bookings have one `Assignment` per member; supporting assignments carry zero fee. Orders retain one linked installation booking and one financial workflow.

New team writes use MongoDB transactions and a shared Manila-day capacity lease. A standalone database is rejected before invitations are created. The production database previously completed the transaction-based payroll cleanup; local fixtures do not establish the current live database configuration. No existing records need backfilling.

The model schemas declare indexes for team member, status, and appointment date. If automatic index creation is disabled in a deployment, include those indexes in its usual database index maintenance process.

## Verification

Regression coverage exercises one/multiple assignment, rollback, individual acceptance, declines, retries, rescheduling, continuations, primary-only actions, order mirrors, project conflicts, and shared kit requirements. Browser fixtures exercise admin/secretary service and order dialogs, desktop/mobile layouts, inline conflicts, and supporting-technician acceptance. Fixtures use synthetic records and do not modify the deployed database.
