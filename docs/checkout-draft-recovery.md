# Checkout progress follows the current aircons

The cart modal retained address, schedule and location state in memory after rejecting a mismatched saved draft. The product ordering modal also scheduled a delayed restore without checking that the same model was still open. A catalogue draft identified its variant partly by list position, and product-page cart checkout could reopen using the original page snapshot.

## Changes

- Cart checkout reads the current server cart before opening. Selected cart rows are preserved when they still match; a cart page restored by browser Back refreshes if its rendered rows have changed. Buy Now uses its freshly loaded cart.
- Cart drafts match the selected product IDs and quantities. Checkbox changes and cart mutations invalidate incompatible progress immediately. A pending save cannot recreate the old draft.
- Every modal open clears its previous fields and map before applying a compatible draft. Changed models reset the schedule, payment reference, receipt preview, pricing quote and checkout request ID. The customer's account phone remains available as the default contact.
- Direct-order drafts locate the variant by its stable ID. Reordering the catalogue cannot restore a different model or HP. Saved quantities must still fit available stock.
- Changing HP or quantity clears schedule and payment choices. An unchanged address retains its transportation fee, while opening a different model clears the old location and map marker.
- Closing or reopening a modal cancels pending restores. Late pricing, calendar availability, slot validation and receipt-preview responses cannot overwrite a newer checkout. Standard schedules and project date windows both reset when their selection changes.
- Matching drafts still resume for 30 minutes. Manual payments return to the receipt step because uploaded files cannot be restored by the browser. Drafts remain customer-scoped and require a valid customer session.

## Verification

Fourteen new regression tests cover mismatched selections, stale saves and restores, catalogue reordering, stock changes, calendar races, project windows and route preservation. Isolated desktop and mobile browser checks cover unchanged progress, different models, quantity changes, rapidly reopened modals and switching between one-unit and ten-unit installation scheduling. Mock APIs are used; no live orders or database records are changed.

Final validation: **55 focused checks passed; full suite 2,025 passed, 0 failed**. Cart and direct-order restoration passed at 1440 and 390 px. Full ten-unit and forty-unit checkout passed at 1440, 390 and 320 px, including the existing staff planning and technician handover checks. JavaScript syntax, EJS compilation and whitespace checks passed.
