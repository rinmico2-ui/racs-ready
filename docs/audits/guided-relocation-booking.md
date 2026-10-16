# Standalone relocation booking

Aircon Relocation covers one aircon and is booked separately from every other core or repair service. The customer cannot select relocation while another service is selected, or select other services while relocation is selected. This applies across appliance groups, saved progress, booking edits and server submissions.

The customer enters the brand, aircon type and HP, selects relocation, and chooses one move option:

- **Nearby, on the same property:** enter the current and new positions, then pin that property. The server saves the same property coordinates with both room descriptions.
- **A different address:** pin the current property and the destination. Both addresses and exact coordinates are required. The destination must be within Nueva Ecija.

Both options use the saved relocation catalog price and work duration for the selected type and HP. They continue through the normal availability calendar, appointment start time, price review and payment. The usual travel fee applies to the current property. No separate destination surcharge is invented. Staff configures the catalog price as for other core services.

## Staff and technician workflow

Relocation creates an ordinary service booking and payment record. It uses the existing admin payment, assignment and acceptance queues, technician preparation, dispatch and relocation work-order checklist. The work order recognizes `different_address` and displays both saved locations.

Separate customer and staff relocation quotation navigation has been removed. Old page URLs redirect to booking lists. Quotation submission, assessment, pricing and acceptance endpoints return HTTP 410 with the normal booking link. Historical request records and authenticated reads remain for audit purposes. Historical quote-priced bookings keep their stored prices and work-order compatibility. No existing records are deleted or repriced by this change.

Old quote-based checkout drafts are discarded rather than silently converted to a different price. New drafts retain their selected move option and map locations. Booking edits preserve saved checklist progress and enforce the same standalone rule; changing a historical quote-priced booking requires staff assistance.

## Validation

Regression tests exercise real booking creation and editing handlers with memory-only persistence, catalog repricing, quantity and combination restrictions, required pins, coverage, retired endpoints, scheduling and technician work orders. Browser checks use the real customer page, shared builders and Leaflet against local synthetic APIs at 1440 px and 390 px. Both move options reach the normal payment page without a quotation submission. These checks do not access the live database, charge money or send customer messages.
