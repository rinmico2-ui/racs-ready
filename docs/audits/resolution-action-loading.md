# Resolution Center action loading

Queue refreshes preserve button contents. The All, Bookings and Orders tabs
contain live count badges used by `loadQueue`; replacing a clicked tab's HTML
with a spinner previously removed its badge, causing a null `textContent`
error. Queue buttons now use an attribute-driven spinner, keep the badge
nodes and their updated counts, and restore their enabled state only after
all overlapping refreshes finish. Regression tests run the actual queue
handler from each tab and check error cleanup and preserved counts.

Updated October 12, 2026. Scope: browser loading feedback and repeated-click protection on the shared admin/secretary Resolution Center page. No backend routes or business rules changed.

`resolution-action-loading.js` provides a shared write guard for payment verification, booking cancellation/refund decisions, rescheduling, schedule invitations, no-show confirmation, closing cases, reassignment, and legacy schedule approvals/rejections. It acquires the guard before starting an action, shows a button spinner and a live progress message, and makes the workspace and Bootstrap modal contents temporarily inert. Repeated submissions and conflicting case actions cannot run until completion, including the queue refresh after a successful action. Errors, cancelled confirmations, and validation failures release the guard.

Order cancellation and delivery/installation/pickup schedule dialogs use a separate opening guard. The opening message ends when the form is ready. Actual submission uses the same write protection as booking actions, disables the popup's Cancel control, and blocks Escape and outside dismissal until its request finishes. Validation errors preserve the form and allow retry. Detail/payment reads and scheduling availability have their own loading guards; overlapping reads retain locks until the last dependent operation finishes. Queue refresh preserves the existing latest-response protection for filters.

Buttons keep their original labels and disabled eligibility unless the original handler deliberately updates them. Schedule availability recalculates Save eligibility after cleanup, so a conflict that clears the slot cannot enable Save accidentally. Pending writes prevent accidental navigation and modal dismissal. The loading panel supports mobile safe areas and reduced motion.

The booking schedule-link handler now receives its clicked button explicitly and does not depend on a browser-global `event`. Successful invitations and cancellations await queue refresh instead of leaving an old case briefly actionable.

Verification: **130 distinct related tests passed** across the loading guard, actual page handlers, payment review, booking/order resolution, scheduling, evidence, counts, cancellations, and order invitations. Coverage includes rapid repeat clicks, overlapping reads, request errors/retries, existing disabled controls, schedule revalidation, modal dismissal, and refreshing before unlocking. The rendered page's inline JavaScript and the external helper passed parsing checks. Tests used local browser/model doubles; no live database or notifications were changed. These changes are local and have not been pushed or deployed.
