# Technician acceptance and KPI fixes

October 11, 2026. Local fixes; deployment and an authenticated production check are still needed.

The browser reported `currentFilter is not defined` from the assignments KPI updater, followed by HTTP 500 and 400 responses from assignment acceptance. The server stack trace for the production 500 was not supplied, so its exact failing operation remains unconfirmed.

The KPI updater runs in a separate script scope from the assignment filter. It now reads the filter through `window.getAssignmentFilter()` and keeps today's visible-work count consistent with the selected tab.

The old acceptance handler saved the assignment first, then saved the booking, synchronized mixed-service items, saved preparation state again and ran notifications. A failure after the first save could return an error after acceptance had already persisted. The next request then failed because the assignment was no longer pending.

Acceptance now commits the booking and assignment in one transaction, with checks for technician ownership, current assignment, booking status and missed schedule. A retry returns the existing acceptance instead of rejecting it. An earlier partial acceptance can repair the booking's early status without resetting checked-out equipment, adding another acceptance entry, or rewinding work already underway. Updates validate the changed fields and preserve customer notes and payment details.

Individual service assignments update their own item and preserve another technician's work. Repair visits retain the distinction between inspection and scheduled repair. Project acceptance verifies membership in the project linked to the booking, and preserves the project's booking status. Delivery/installation orders retain their separate order workflow.

Audit, availability, email, notification and toolkit follow-ups run after the acceptance commit. Failures are logged and do not turn saved acceptance into HTTP 500. A toolkit failure tells the technician to reload Daily Preparation. Customer and staff status events use the committed booking state. The departure preparation checks remain enforced.

The browser handles failed connections, non-JSON responses and failed page refreshes. It refreshes jobs, preparation and KPIs after success and does not claim an unreadable response means acceptance succeeded.

91 checks passed across 14 test files. New tests exercise transactional rollback, duplicate requests, recovery of partial acceptance, changed ownership, cancellation, missed schedules, individual items, repair phases, projects, database setup errors, failed follow-ups, KPI scope and the Accept button's response handling. Ten rendered inline scripts and both backend files also compiled successfully. Tests used in-memory models and did not change live records or send emails.
