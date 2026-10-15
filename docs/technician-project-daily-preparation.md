# Technician project mobilization and Daily Preparation

## Changes

- Project GPS updates now use `/api/auth/technician/location`, the same endpoint as the existing tracker. `/api/technician/location` is also supported for older open tabs. Both handlers only update the authenticated technician and validate latitude/longitude.
- Project work selection and kit checks use `Asia/Manila` work-day boundaries, matching the shared kit service. A UTC server no longer selects the previous kit date during the Philippine morning.
- Each execution project card shows today's scheduled crew, each person's preparation blocker, and a button to open the existing shared Daily Preparation modal. Closing that modal refreshes the crew status.
- Crew departure and Start Work use the same kit status, unconfirmed update, and pending-return checks as standard bookings. All current project daily assignments must be included in their technician's kit. Making item decisions alone does not issue equipment or consumables; the kit update must be confirmed.
- Mobilization errors remain visible on the project card. Unexpected non-JSON server responses receive a readable error. GPS is sent only after En Route succeeds.
- The preparation preview requires authenticated project membership, does not write or issue stock, and is not publicly cached. The server synchronizes and checks each kit when authorizing departure or starting work.

## Workflow after deployment

1. Operations verifies the purchase payment and dispatch preparation when this is an aircon purchase. Complete the project plan and commit the actual work dates and crew daily assignments.
2. Crew members accept participation and complete any required daily availability confirmation.
3. The existing automatic kit monitor includes committed project daily assignments. It starts after the database connects and scans every minute. Opening Daily Preparation is not required for generation. A provisional plan is not an instruction to issue inventory.
4. Each technician opens **Prepare my daily kit** on their project card. This is their shared kit for bookings, installation orders, and projects on that date. Resolve unavailable items, pack the full required quantities, and confirm preparation on the scheduled day.
5. The lead refreshes crew status, then selects **En Route**, **Arrived**, and **Start Work**. Every scheduled crew member must be prepared. Added requirements or pending returns can block Start Work even after travel was accepted.
6. For another workday, review that day's committed schedule and kit. Preparation from a previous day does not authorize today's work.

Site-assessment travel keeps its existing separate lifecycle. The execution kit gate applies to committed project work; this change does not invent an execution kit for a provisional assessment visit.

## Interpreting remaining conflicts

| Code or message | Required action |
| --- | --- |
| `ORDER_PAYMENT_NOT_VERIFIED` | Operations must verify the purchase downpayment. |
| `ORDER_PREPARATION_REQUIRED` | Operations must complete dispatch preparation. |
| `PROJECT_WORK_NOT_SCHEDULED` | Operations must commit a project work schedule for that day. Legacy projects without daily assignments need a committed schedule before executing. |
| `DAILY_KIT_REQUIRED` | Inspect the crew list; every scheduled technician confirms their own shared kit. |
| `DAILY_KIT_DELTA_REQUIRED` in a crew row | Pack and confirm the additional requirements. Item decisions alone are insufficient. |
| `DAILY_KIT_RETURN_PENDING` in a crew row | Resolve the equipment/material return awaiting office receipt. |
| `DAILY_KIT_JOB_NOT_INCLUDED` in a crew row | Refresh Daily Preparation and review newly added project work. |
| Waiting for daily confirmation / no active work today | Complete availability confirmation or have operations check the day's schedule. |

Payment, dispatch, team acceptance, project membership, and arrival requirements remain enforced. A `409` is a deliberate conflict response when a prerequisite is incomplete. The supplied production screenshot/request metadata did not include the response JSON, so it does not identify which prerequisite blocked that specific project.

## Validation and deployment

- 20 new regression tests cover Philippine day boundaries on a UTC host, read-only previews, crew-wide readiness, kit updates/returns/coverage, cancelled work, Start Work rechecks, purchase prerequisites, GPS validation, and project membership.
- Full local suite: **2,151 passed, 0 failed**.
- Isolated Edge checks at **1440px and 390px** use the actual project and shared kit templates with synthetic API responses. They cover packing/confirmation, crew refresh, visible kit/payment/gateway failures, successful travel-to-start, and the canonical GPS URL. They do not certify production data or email delivery.

Deploy the updated application in Dokploy, then refresh the technician assignments page. No production database records were modified during this work. If a crew remains blocked, use the specific message on its project card to complete the outstanding prerequisite.
