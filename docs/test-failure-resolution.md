# Resolution of the 23 remaining test failures

Completed on 14 October 2026. All previously failing checks now pass. No tests were removed or skipped, and existing purchase, walk-in, payroll, permission, and payment controls were retained.

## Application fixes

- Maintenance maps on both customer and staff pages now use the shared Esri hybrid provider. The old OpenStreetMap tile URLs conflicted with the application's allowed map hosts. The maps reuse one instance, retain attribution, support the shared zoom range, and fall back to address selection if the map dependencies are unavailable. Asset versions were updated to invalidate cached scripts.
- Explicit price questions such as “How much is aircon installation?”, “Magkano ang pagkakabit ng aircon?”, and “What's the price of aircon installation?” now select the pricing intent. Previously, the appliance and service keywords accumulated enough matches to override the question. General service questions retain their service intent.

## Test corrections

| Area | Previously failed | Resolution |
| --- | ---: | --- |
| Admin performance | 2 | Added the new kit-return and inventory count dependencies to the fixture. Asserted the current chart-free inventory rendering behavior instead of a removed chart loader. |
| Admin order tabs | 1 | Verified that the script is loaded with a version rather than requiring an obsolete version string. |
| Booking history | 1 | Supplied the actual repair-unit and project-payment utilities used by project conversion. |
| Booking quantity limit | 1 | Accepted the current “40 appliances” terminology while retaining the quantity and HTTP 400 checks. |
| Cart checkout layout | 2 | Removed a hardcoded calendar asset version; verified the wrapping mobile legend, including holiday and no-service explanations. |
| Chatbot | 1 | Fixed explicit pricing-question precedence and expanded English and Filipino coverage. |
| Customer booking UI | 4 | Tested the current appliance/details/services builder and existing booking review and repair controls instead of retired service-list markup. |
| Expired booking slots | 1 | Accepted the current plain-language warning while requiring instructions to choose another time. |
| Maps | 2 | Fixed both maintenance map providers. Added runtime coverage for reuse and missing-dependency handling. |
| Staff order API | 1 | Captured all query selections. The old fixture replaced the photo-exclusion selection with the later staff-only selection; actual Mongoose queries preserve both. |
| Technician order updates | 1 | Exercised the shared live-update handler, including deferral while a dialog is open, rather than extracting deleted inline code. |
| Order totals | 1 | Exercised the actual save hook and customer checkout calculations for discounts, decimal rounding, pickup, transportation, and installation-fee exclusion. |
| Location/fare UI | 1 | Supplied the relocation-controller dependency when testing ordinary service-location behavior. |
| Secretary navigation | 1 | Verified the current Reports and Ratings label and permission-scoped maintenance link. Admin-only links remain prohibited. |
| Technician dashboard counts | 1 | Verified the shared work scope excludes projects and order-backed visits before counting, replacing an obsolete query-pattern assertion. |
| Travel fare consistency | 1 | Supplied valid route geometry in the mock. Its missing geometry correctly triggered the estimate fallback; a valid road route now verifies 74.9 km and the same configured fare as service booking. |
| Walk-in POS | 1 | Verified that aircon transactions use the Orders checkout handler and remain separate from merchandise checkout and barcode lookup. The current supported aircon tab was retained. |
| **Total** | **23** | **All passing.** |

## Verification

- Latest full suite: **1,962 tests passed, 0 failed**, across 271 test files, including the POS timestamp follow-up below.
- JavaScript syntax and EJS compilation: **95 changed/new files passed**. Git diff whitespace check passed.
- Isolated Edge browser checks passed both maintenance map initializers with actual Leaflet and local tile fixtures, including provider reuse, attribution, and zoom. The 1 HP/3 HP purchase, payroll, CSV import, invoice recovery, PDF download, and mobile checks also passed with no JavaScript exceptions.
- Browser API fixtures use memory-only records. No live orders, inventory, payroll, or payment records were created during verification.

Restart or redeploy the application to load the changes. `.env` was not modified.

## POS timestamp follow-up

An admin checkout reported `Tool validation failed` with both `createdAt` and `updatedAt` stored as `{}`. The existing recovery hook repaired only the creation date, and returned early when that date was already valid. Mongoose validates before its save timestamp middleware, so the invalid update date still blocked checkout.

The Tool validation hook now repairs each malformed legacy timestamp independently. Creation dates use the existing ObjectId timestamp fallback; invalid update dates use the current time. Valid dates and new-record input validation are preserved. The date repairs are persisted in the same stock transaction, so a failed receipt write rolls them back.

The expanded fixture reproduced the exact reported error before the fix. All 13 timestamp tests now pass, including admin and secretary checkout, receipt voiding, independent malformed fields, valid-date preservation, reserved stock, operational assets, and rollback. All 21 targeted POS checks passed.

A read-only catalog check found 198 Tool records with object-valued creation dates and 184 with object-valued update dates. Five affected records validated successfully in memory using the patched model. No catalog data, stock, sales, or payments were written by this verification; normal successful saves perform the repair.
