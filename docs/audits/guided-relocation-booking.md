# Guided relocation booking

Aircon Relocation is selected with the other services in the appliance-first form. It reuses the entered brand, model, aircon type and HP. It does not open the legacy setup modal or reset those details.

Selecting relocation reveals two choices:

- **Nearby, on the same property:** the customer enters the current and new positions, then pins the property in the location step. The existing catalog price and duration apply. Both positions receive that property address and coordinates on the server. One aircon may have relocation and another service; it remains one physical unit.
- **Another address or a distant position:** the customer selects only relocation and continues to the two-location map. The request is submitted for a staff quote after a preferred date is chosen. No payment, booking or technician assignment is created at this stage. The accepted quote still follows the existing reviewed booking flow.

Each relocation request covers one aircon, matching the existing booking and quote rules. Customers with several aircons make separate relocation requests.

## Location step

The current address is the existing service-address input and green pin. After a valid current point is selected, the map automatically targets the destination and enables its address field. Customers can explicitly switch between Current address and New address. Destination address suggestions appear while typing; choosing a suggestion places the orange pin. A map click can place the destination without requiring an address first. Reverse geocoding fills the address, while a manually entered address remains saved with its exact chosen pin.

Dragging the destination changes only its coordinates. The map fits both markers immediately. The current pin is retained. The dashed orange line connects the two points; it is not a driving-distance quote. Staff reviews transport costs in the existing quote workflow.

Editing destination text removes the previous destination coordinates, marker and line until a new suggestion or pin is selected. Debounced requests are cancelled and versioned so an old response cannot replace newer text, a newer pin, or another relocation. Missing points prevent submission on both the client and request endpoint. Existing accepted quotes remain read-only in the destination step.

Aircon details and both points are saved in the relocation request, carried into the accepted booking, and used by the existing staff and technician relocation views. Nearby moves also persist both property coordinates directly in the booking instead of relying on a later fallback. No existing customer records were changed.

## Verification

Memory-only tests cover service selection, position requirements, one-unit limits, fixed catalog prices, quote isolation, map target changes, stale requests, autocomplete, manual points, shared-property points, endpoint validation and saved booking coordinates. Existing relocation work-order, checklist, ownership, map, scheduling and draft tests pass.

Local browser checks at 1440, 390 and 320 pixels use the real customer wizard, real relocation map handlers and Leaflet with mocked address responses. They verify preserved aircon details, scope edits, both independent markers, autocomplete, map clicks, dragging and the actual quote-submission payload. They do not use MongoDB, send notifications or write live bookings.
