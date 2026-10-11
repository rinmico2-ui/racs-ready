# Order preparation and technician handoff

Audit date: 2026-10-11. Scope: application source and isolated tests; no live
customer order was changed during this audit.

## Who does what

| Step | Owner | Result |
| --- | --- | --- |
| Review payment and assign a technician | Admin or secretary | Reserves the technician; aircon preparation remains independent. |
| Accept the assignment | Assigned technician | Confirms the work; does not mark the purchased aircon prepared. |
| Check aircon, accessories and packing; click Confirm Unit Prepared | Admin or secretary | Records the staff account, time and note, and notifies the assigned technician. |
| Prepare and confirm installation tools and supplies | Assigned technician | Confirms the Daily Kit for the installation date. |
| Mark En Route | Assigned technician | Server checks the schedule, aircon preparation and installation kit. |

Unit preparation can happen before or after assignment and acceptance. It must
be a staff confirmation of actual preparation, rather than an automatic side
effect of assigning a technician. For an accepted order scheduled tomorrow, the
admin uses **In Progress -> Confirm Unit Prepared** or the same action in order
details. The technician prepares the installation kit while waiting.

## Findings and changes

- Preparation previously saved without notifying the assigned technician.
  A saved notification now links to that order, and connected order pages refresh.
- The confirmation button existed in assignment, waiting and active lists but
  was absent from the details footer. It is now available in details too.
- The old success message said the unit was cleared for departure even when the
  installation kit was pending. Labels now distinguish the two requirements.
- Unprepared deliveries scheduled today or tomorrow show a staff warning, using
  Philippine dates. These are page warnings, rather than scheduled email alerts.
- The technician's kit progress message could replace a missed-schedule warning.
  Schedule recovery now keeps priority.
- Preparation updates only its own fields with a guarded database update.
  Retries preserve the original confirmation and avoid duplicate notifications.
- Kit summary saves previously marked the entire preparation field as changed,
  which could overwrite a newer staff confirmation. They now update only the
  installation field and check the assignment and schedule before saving.
- Installation kit status changes refresh the admin and assigned technician
  after the updated order saves.

Customer pickup keeps its separate Ready for Pickup and collection workflow.
Preparation does not bypass payment review, technician acceptance or schedule
recovery. A late delivery goes through Resolution Center before departure.

## Verification

`server/tests/order-preparation-handoff.test.js` exercises staff permissions,
preparation at different assignment stages, first-confirmation preservation,
concurrent changes, notification failures, Philippine date warnings, departure
checks, technician progress and live refresh. Existing payment, receipt, order
presentation, fulfillment and technician workflow checks also cover this change.

Deployment validation: use an intended delivery-and-installation order, assign
and accept it while preparation remains pending, then have staff confirm the
aircon and the technician confirm the kit. Check that both screens agree before
starting the scheduled delivery. This live action has not been performed by
the coding agent.
