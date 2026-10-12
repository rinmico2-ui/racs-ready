# Technician Daily Kit check

Checked on October 11, 2026. Scope: future work dates, preparation checks, missing-item reports, inventory confirmation, and the connection to admin equipment records. This was a local source and behavior audit. No live database connection was opened, no stock was issued, and no notifications were sent. Application code was not changed.

## Per-service Kit Rules — October 12, 2026

Admin can edit kit defaults at `/admin/services/kit-rules`, linked from the service catalogs, repair categories, Technician Tools, and sidebar. The directory includes every non-archived CoreService and ServiceCategory plus every RepairService, including inactive records. Customer repair requests use ServiceCategory records, so those categories have their own rules as well as the older priced repair catalog.

Each rule uses its exact service model and ID. Each item uses its exact Tool ID, quantity, and either per-visit or per-aircon quantity. Repair rules contain separate inspection and repair-visit lists. Repair parts remain controlled by the quotation rather than a generic kit template. Empty visit lists require an explicit confirmation. Active zero-stock items remain selectable so shortages can be reported; unavailable, archived, retired, damaged, unassignable, and sellable equipment is rejected when saving.

Rules are stored separately in ServiceKitRule with a unique service identity, conditional revision updates, actor/time details, and the latest 20 revisions. Concurrent first saves and stale edits return HTTP 409 without overwriting the newer rule. Editing is restricted to admin with services.manage permission. Unsaved browser edits are guarded, both repair phases are validated, and failed saves retain the draft.

Standard service assignments use only their service item and assigned quantity. Customer-created repairs resolve their saved category slug, with an exact unique unit-type fallback for older records; mixed repairs do not inherit the parent's core service ID. Delivery installations use the installation service rule as one visit across all order lines. Consumables are summed and reusable equipment is shared without multiplying configured quantities twice. Services without a custom rule retain their existing suggestions; resetting a rule restores those defaults.

New project resource suggestions use the configured service lists, scoped to their work orders and unit groups, and bypass generic web resource guesses. Project crew equipment and per-unit materials are calculated before being stored as fixed planning quantities. Existing confirmed project plans remain snapshots and are not rewritten by global rule edits. Older work orders missing service/unit links need their planning details updated before using these rules.

Daily Kit refresh preserves issued custody records. Exact catalog rules do not substitute another inventory item with the same name; changed requirements create additional rows needing a new physical check and confirmation. An explicitly empty installation list is recorded for its order, while unrelated empty kits still block departure. Saving a template does not reserve, deduct, issue, or return stock.

Validation: **253 related tests passed** across 19 files, including rule identity, repair categories/phases, mixed assignments, order quantities, work-order scope, permissions, concurrent saves, input validation, browser editing, and transactional checkout/returns. Tests used local model doubles and schema validation. No live database, inventory, email, or notifications were changed. These changes are local and have not been pushed or deployed.

## Default kit preview — October 12, 2026

The Kit Rules editor now displays the current default equipment and consumables automatically for each service, including base quantities, units, available stock, and missing catalog items. Repair phase tabs also work while using defaults. The default list stays separate from custom edits and remains available for comparison.

Preview and technician generation share `buildDefaultServicePreparation`, which uses the existing matching and stock-selection logic. All previews reuse one catalog read rather than querying inventory for every service. The screen explains that quantities are shown for one aircon/unit, that booking details may affect the final kit, and that existing kits can retain their previous inventory choices. Opening or changing a preview does not save a rule or reserve stock.

Validation: **258 related tests passed**, including matching the preview to actual generation, shortages, separate repair phases, custom-list isolation, and all existing kit checkout checks. JavaScript syntax, page rendering, and whitespace checks passed. No live database writes or deployment were performed.

## What is supported

- Assignments and installation orders use the shared Daily Preparation component. Its date field and upcoming-work buttons request the selected day's kit.
- The kit combines accepted service assignments, delivery-and-installation orders, and confirmed project work for a technician and date.
- Future dates are previews. The shared UI and server restrict physical checkmarks and kit confirmation to the scheduled work date in Philippine time.
- Equipment requirements are combined for reuse; materials cover total demand. The kit retains links to the jobs that need those items.
- Preparation updates are required when new accepted jobs or items are added after confirmation.
- The tools return service has local coverage for ownership, stock restoration, damaged equipment, shared jobs, and rollback on failures.

## Confirmed problems

### 1. Notify admin fails before sending the report

`server/routes/technicianApi.js:10760` refers to `eqAssignments`, which is not defined in the `/daily-kit/notify-admin-item` handler. The shared kit uses this endpoint. Executing the actual handler with model doubles reproduced HTTP 500 and `ReferenceError: eqAssignments is not defined`, before any kit save or notification. This action therefore needs repair even for today's kit.

### 2. Future kits cannot report missing items from the UI

`server/views/partials/technician-order-daily-kit.ejs:146` removes all item-action buttons for dates other than today, including Notify admin. Executing the shared renderer with a future kit and unavailable items confirmed that those actions are removed and confirmation is hidden.

Future preview works as a viewing feature, but my earlier explanation overstated its support for arranging missing items through the application. A technician must currently contact staff outside the future kit's actions. Reporting a future shortage should be allowed separately from physical checks and inventory issuance.

### 3. Work-date queries depend on the server timezone

`server/utils/dailyKitService.js:24` builds day boundaries with host-local midnight. The upcoming-date response at `server/routes/technicianApi.js:9747` also uses host-local date getters, while the shared browser UI uses Philippine dates.

On a UTC host, a booking stored as October 12 at midnight in the Philippines is labelled October 11 by the actual upcoming handler. The actual October 12 day-bound query also excludes that timestamp. Both results were reproduced with isolated code and model doubles. This is conditional on the deployed server timezone; Dokploy's running timezone was not inspected. Date-only queries need explicit Philippine boundaries and labels.

### 4. A failed confirmation can leave a partial checkout

`confirmDailyKit` in `server/utils/dailyKitService.js` deducts inventory and creates checkout records one item at a time before saving the confirmed kit. Those operations are not wrapped in one transaction.

A simulated two-item confirmation let the first equipment checkout succeed and made the second material unavailable. The function rejected the confirmation, but the first stock deduction and checkout record remained, while the kit was not saved as confirmed. This is a failure-recovery issue; the probe changed only local doubles. Confirmation needs an atomic transaction or equivalent reliable rollback and retry protection.

### 5. Admin's pending-item list excludes future dates

Source inspection of `server/routes/adminApi.js:9703` shows that `/daily-kit/pending-issues` queries only today's kit items. It also processes only `items`, rather than pending additional items in `deltaItems`. Even after repairing Notify admin and allowing future reports, that dashboard list would need date-aware coverage for staff to handle tomorrow's shortages there. The separate admin Technician Tools page does offer a selected-date kit view; the two views should be consistent.

## Validation and limits

- **45 existing checks passed** across the technician kit checklist, shared presentation, repair preparation, project allocation, admin presentation, and tools return/usage workflows.
- **Four additional behavior probes reproduced** the notification error, removal of future report actions, UTC date mismatch, and partial checkout on failed confirmation. These exercised actual handlers/functions/rendering with doubles and opened no database connection.
- Passing the existing checks does not establish that the deployed kit flow is fully working; their coverage missed the reproduced cases above.
- Recommended repair order: fix missing-item reporting, make confirmation atomic, and standardize Philippine date boundaries. Future shortage reporting would be a separate planning feature if requested; physical checks and stock issuance should remain restricted to the work date.

## Follow-up: scheduled-date rule and equipment sharing

The customer clarified that actual preparation and checkout should happen only on the scheduled work date. Future preview is a planning view, not an early checkout or reservation. Hiding future checkmarks and confirmation is therefore expected behavior. The absence of future item actions and the admin dashboard's today-only list above should be treated as planning limitations, rather than failures of this scheduled-date requirement. Today's Notify admin error remains a confirmed bug.

### Protection already present

The main `setDailyKitItemChecked` and `confirmDailyKit` functions reject dates other than today in Philippine time before syncing or writing the kit. Probes with both past and future dates confirmed HTTP 409 errors with no kit sync or stock writes.

The main confirmation uses a conditional stock update at `server/utils/dailyKitService.js:703`: it requires sufficient quantity and deducts that quantity in the same operation. A model double preserving this conditional-update behavior was shared between two overlapping technician confirmations. With one available pump, one confirmation succeeded and the other failed; with two pumps, both succeeded. Stock did not go negative, and the number of checkout records matched the available quantity. This is local verification of the update contract, not a live MongoDB load test.

Opening a future kit creates or updates a draft of requirements but does not check out equipment, deduct physical stock, or create an equipment hold. Two future previews can therefore show the same currently available tool. The actual checkout must decide who receives it. A confirmed booking alone does not guarantee exclusive possession of a tool for its future date.

### Gaps in the scheduled-date rule

Older checkout handlers remain available at `server/routes/technicianApi.js:3718` (`/assignments/checkout-batch`), `:3802` (`/assignments/:id/checkout`) and `:11242` (`/equipment/:assignmentId/checkout`). These do not enforce the main Daily Kit's work-date check. Executing the actual equipment checkout handler with a reserved row dated the following day successfully deducted stock and marked it checked out. The double changed no live data.

The repair should route every physical checkout through one shared date, ownership, readiness and inventory rule. Do not enable future confirmation to work around these gaps.

### Gaps in equipment sharing

1. **Older checkout paths use read-then-save stock updates.** Two executions of the actual equipment checkout handler were synchronized so both read one available pump before either saved it. Both succeeded and created checked-out assignment states; the stock ended at zero even though two technicians were recorded as holding the single pump. These paths need a conditional stock update and transaction, rather than separate reads and saves.

2. **The same kit can be confirmed twice concurrently.** Two calls to the actual confirmation function, each seeing a draft snapshot of the same kit, took two pumps from a stock of two for a one-pump requirement. They created two checkout records. The per-item stock guard prevents negative stock, but does not enforce a single checkout per kit item. There is no atomic confirmation claim or unique kit-item checkout key covering this function. Add retry-safe confirmation and a transaction.

3. **A competing reservation is not checked in the final stock update.** Availability subtracts `reservedQuantity`, but the final conditional update checks only `quantity`. A probe added another job's reservation after the availability read and before checkout; confirmation took the reserved pump, leaving quantity zero and reserved quantity one. Recheck unreserved stock during the final write, and consume a reservation only when it belongs to the current job or kit.

4. **Standard kits assume personal possession.** `server/utils/dailyKitService.js:355` uses a catalog-level `standardTechnicianKit` flag to count an item as already carried, before checking its availability/condition. It does not verify that this technician actually has an issued unit. A hydration probe counted the same flagged item as covered for two technicians even with zero stock and no custody records. The flag can describe equipment every technician is required to carry, but it cannot prove individual ownership of a shared company tool. Use technician-specific custody for company equipment and distinguish personal tools from shared inventory.

The previously reproduced partial checkout on failed multi-item confirmation is also relevant here: failure must restore every earlier stock change and checkout record, not just return an error.

### Follow-up verification

Eight additional local probes covered date rejection, one-pump and two-pump competition, duplicate kit confirmation, a competing reservation, early legacy checkout, overlapping legacy checkouts, and the standard-kit custody assumption. All exercised actual source with model doubles; no database connection or notification was made. A further **45 existing checks passed** for order preparation handoff, kit-based departure, and equipment return policy. Application code was not changed. The deployed behavior and actual inventory ownership have not been inspected.

## Follow-up: repairs implemented locally

The customer authorized fixing the audited issues while keeping physical preparation on the scheduled date. The implementation now has one transaction for kit confirmation, stock changes, custody records, approved-parts reservations, booking/assignment preparation flags, project/day records, and installation preparation summaries. Transaction retries re-read the current kit; a confirmed kit without an update returns its saved result. A later failure rolls back earlier checkouts. Live installation notifications are emitted only after the transaction commits.

Kit refresh and physical checkmarks use transactions too. Reads and writes on a transaction session run sequentially. The kit model uses optimistic concurrency to stop older direct edits from overwriting a newer kit, and documents returned from completed transactions have their session detached so existing project-item editing can still save them. Duplicate initial-kit creation is retried once, then returns a clear refresh message rather than issuing stock twice.

Day boundaries, upcoming-date labels, and the current-day shortage list now use Philippine dates independently of the server timezone. Date-only inputs are validated. ISO timestamps are checked by their actual Philippine day, so a UTC date prefix cannot bypass the work-date rule. Future kits remain previews and do not issue or reserve stock.

All three older equipment checkout endpoints delegate to the same kit confirmation gate, including ownership, accepted-job coverage and required checkmarks. The older kit-generation URL redirects to the canonical selected-date endpoint. Older checkout buttons open Daily Preparation when that gate rejects an incomplete checklist. The older booking-level return endpoint now uses the existing transactional equipment return service, which checks remaining shared work and ownership before making stock available again.

The final stock update protects unreserved quantity and releases only reservations owned by the technician's covered jobs. Explicit owned equipment reservations are included in the kit and their existing checkout records are reused. Approved repair parts distinguish stock already deducted from soft holds; the former are not deducted a second time, while the latter are deducted once during checkout. Parts reservation claims participate in the same transaction.

The catalog's standard-kit flag no longer proves possession. Company equipment needs stock or an individual custody record. Existing custody, including older account-ID records and equipment held from a previous date, is verified and reused. Partial custody takes only the missing quantity. Custody records are claimed during confirmation to protect against concurrent returns or damage reports. Cancelled/reassigned bookings and cancelled project work are excluded. Additional requirements need a new checkmark and preserve all checkout links when merged into the kit. Older confirmed rows that relied on the unverified standard-kit assumption must be reviewed again.

The missing-item report no longer references an undefined variable. Notifications use a valid `DailyKit` reference and open the admin's kit view on its work date. The secretary link points to the supported inventory page. A failed notification is reported separately from the saved issue. Both the admin shortage list and resolution handler include additional kit items, and their pending reports survive kit refreshes. Future action controls remain hidden, as required by the scheduled-date workflow.

Validation: **177 related checks passed, 0 failed** across sixteen test files. Eighteen new behavior checks exercise the actual kit service with transactional model doubles, including concurrent confirmations, one versus two available tools, whole-checkout rollback, reservations, repair parts, custody, late additions, ownership, project cancellation and actual notification handler/schema validation. Existing checks cover equipment returns, acceptance, maintenance completion/payment, order preparation/departure, shared UI rendering and notifications. JavaScript syntax and whitespace checks passed. These are local automated checks, not a live MongoDB concurrency test or a completed deployed visit. No live inventory was changed, and the repairs have not been pushed or deployed.

## October 12: checklist save interaction

The technician reported that checking each tool interrupted the entire checklist. The browser disabled every checkbox, submitted the check, then made another expensive kit GET and replaced the modal body with a loading message before rebuilding every row. Ordinary checks now update the existing row and progress immediately, queue saves sequentially, and use the POST's authoritative kit response. They do not request another kit GET or replace the checklist DOM. Other tools remain usable while a check saves; changing the same checkbox while it saves queues the latest choice.

Each pending row shows Saving, and confirmation stays disabled until all queued checks finish. A failed check rolls back that row, shows a retry message and allows other queued checks to finish. Changed server requirements can still rebuild the list, preserving scroll. Date and kit identity checks prevent a late response from replacing another work date, and acknowledgements protect saved checks from an overlapping older GET without retaining them after quantity or availability changes. Closing the browser while saves are pending uses the browser's unsaved-work prompt.

The server check and checkout handlers retain their transaction, work-date, stock and ownership checks. This change improves browser interaction and removes the redundant request; it does not claim a measured reduction in server processing time. No live database or equipment records were changed for this UI fix.

Validation: **91 tests passed** across eight related test files, including eleven new browser-script behavior checks with delayed fetch responses, failed saves, rapid toggles, date changes, overlapping reads, changed quantities, confirmation blocking and DOM/scroll preservation. EJS and inline JavaScript parsing also passed. The changes are local and have not been pushed or deployed.

## October 12: add and remove extra items

Daily Preparation now exposes a catalog search for extra company equipment and consumables while the current work-date kit is a draft. The technician chooses a covered booking, installation order or project day, a total quantity to pack and a short reason. The total never lowers generated job demand. Repair parts remain tied to approved repair quotations. The catalog shows unreserved stock and excludes inactive, archived, discontinued, unusable and unassignable equipment. A zero-stock item can be selected to expose its shortage for staff review; adding it does not reserve or issue stock.

Add/remove handlers use the authenticated technician and the shared transaction service. Required quantity and the manual packing request are stored separately so an extra survives refresh even when it uses the same catalog entry as a generated requirement. Manual requests are hydrated against current availability before checkmarks or checkout; changing the packing quantity clears the previous physical check. Each new extra is linked to its selected job for subsequent material usage, and unissued extras stop contributing when that job is cancelled or reassigned. Reasons and account IDs are recorded in kit notes.

Remove extra deletes a standalone unissued extra or restores a merged row to its generated minimum. It never changes stock, erases required demand or deletes a custody/reservation record. Confirmed kits cannot use these manual edit endpoints; issued equipment uses My Tools returns. For an unissued generated item, Not needed records a reason while leaving the row visible. Decisions now reject other work dates and restrict confirmed kits to their pending additional rows. Shared buttons send the row ID to distinguish catalog entries with similar names.

The browser keeps other check saves separate from item edits, disables conflicting actions while an edit runs, renders the returned kit without another GET/loading state and preserves scroll. Both booking assignments and installation orders use this component.

Validation: the full seventeen-file related suite passed **207 checks**, followed by **33 passing item/checkout checks** including one additional actual-schema Not needed test (**208 distinct passing checks**). Coverage includes extra persistence, stock rehydration, removing only the extra quantity, preserving generated requirements/custody, date and job ownership, invalid inputs, full rollback after a later save failure, cancelled work, actual add/remove handlers, decision restrictions and shared browser controls. Syntax and whitespace checks passed. All database behavior used local model doubles; no live inventory or booking records were changed. The changes have not been pushed or deployed.
