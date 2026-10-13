# Appliance repair workflow

The booking quantity represents physical appliances. Customers can keep appliances with the same brand/type together and label each appliance and its reported problem separately. Different brands/types remain separate service groups. The existing maximum of 40 appliances and project threshold remain in place.

Project scheduling and staff approval use the same rule: eight or more appliances, or a smaller workload exceeding the configured project-hours threshold (eight hours by default). Core services use their saved service durations; repairs initially use the configured inspection time per appliance. Inspection time is not a promise of how long the repair itself will take. The repair plan and prices follow individual inspection and customer approval. The quantity-based `isLargeScale` flag remains a size label; it does not prevent approval of a valid smaller multi-day project.

Project payment viewing reads both project-linked and source-booking payment records. It shows submitted payments separately from money received, using the source booking total rather than subtracting a pending deposit from the displayed total. Staff must confirm the receipt explicitly before approval when a deposit is required. Receipt review updates the payment ledger, booking and project snapshot in one transaction, preserves the original receipt and work status, and safely handles repeated confirmation. Zero-value pending records do not block projects with no required deposit. An inspection estimate is not treated as an approved repair quotation for final collection.

## Flow

1. The customer enters the appliance count, labels, and reported problems. Booking and project creation preserve these records and model names.
2. The assigned technician records arrival and enters findings, diagnosis, parts, and labor category for each appliance. Catalog selling prices and configured labor fees determine the quote; client-supplied totals are ignored.
3. Every repair appliance needs an inspection and quote before the lead submits the report. A project containing both core work and repair work starts in assessment.
4. An admin or secretary reviews the prices, sends them to the customer, or returns them with a reason for changes. Staff approval does not authorize repairs.
5. The customer approves or declines selected appliances. Quote revision and document version checks reject stale or duplicate decisions. Execution waits until every repair appliance has a decision.
6. Declined repairs are excluded from repair charges and work scope. Their work-order units are cancelled, and daily allocations for those units are removed. Unstarted quantity-only legacy work orders are retained as cancelled records for replacement with individual unit plans. Started legacy work requires staff review.
7. Technicians select the exact customer-approved appliances they completed. Project submissions retain the existing proof-photo and material-use requirements; a count alone cannot complete repairs. Standard repairs record unit completion before the existing payment/proof completion step.
8. Project completion updates the linked booking appliance records in the same transaction. Aftercare asset generation includes repaired appliances and skips declined repairs.

## Screens and access

- Customer booking: **Details for each appliance** under the reported problem.
- Customer booking history: **Appliance repairs and prices** in booking details.
- Admin/secretary bookings and project details: **Appliance repairs** for review.
- Technician assignments and project cards: **Appliance repairs** for inspection, quote details, and unit completion.

Customer records are scoped to the signed-in owner. Technicians can read only assigned work; project inspection belongs to the lead, and standard appliance changes respect the service-item assignee. Admin and secretary review cannot impersonate a customer decision. Closed requests are read-only. Technician notifications are sent to the assigned accounts.

## Existing records

Completed and cancelled records are not rewritten. Open legacy projects can explicitly start individual inspection tracking only when no work has started; the prior aggregate quotation is retained in quote history. Payment records are kept. This change does not invent an inspection or customer approval for old appliances. Missing daily unit mappings require staff to update the work plan rather than guessing which appliances belong to a day.

## Verification

All database methods in automated route tests are mocked. Tests cover forty appliances, different reported problems and prices, mixed services, controlled prices, ownership and roles, stale decisions, incomplete inspection rejection, selected approvals, declined work allocations, completion identity, older endpoint bypass prevention, and aftercare eligibility. Relevant repair, booking-edit, technician, pricing, and maintenance regression tests are included.

The local Edge browser fixture uses in-memory records and tests customer fields, technician inspections, staff review, selected customer decisions, exact-unit completion with proof, duplicate-click prevention, and 1440/390/320-pixel layouts. Live MongoDB records were not changed. Deployment and production acceptance checks remain separate from these local checks.
