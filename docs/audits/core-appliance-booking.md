# Appliance-first core booking

Customers choose Aircon, Refrigerator or Freezer, enter their brand/model and quantity once, then choose compatible services. Aircons also need a supported type and HP. Each group covers appliances with the same details and selected services; add another group when their details differ.

The customer form shows one step at a time: Appliance, Details, Services. Back preserves selections. After adding or updating an appliance, it shows the next action, Service address. Customers can start another appliance or continue their booking. Unfinished edits must be saved or cancelled before the customer moves on.

The setup footer stays at the bottom of the screen while scrolling inside the form. Next and Add to booking use a solid green background; Back uses a pale green fill, and Start over uses a neutral fill. On small screens the main action spans its own row below the secondary controls. Validation messages stay inside the opaque footer. During core setup the separate booking action bar is hidden to avoid overlapping controls; it returns after saving or switching to Repair Service. No booking, pricing or payment rules change.

Quantity is limited to the remaining space in a 40-appliance booking, including repair items. The form displays the used count and remaining allowance, adjusts entries above that allowance with a message, and disables the plus button at the limit. Existing groups are excluded from the used count when editing their quantity. Fractional and invalid quantities cannot advance to the service step. Backend validation still enforces the booking limit.

One aircon with cleaning and recharge is one physical appliance and two priced tasks. Group identity survives drafts, submission, booking changes, project unit groups, work orders and aftercare. Billing and capacity sum every selected service; physical counts sum each appliance group once. Legacy bookings without group identity keep their existing independent service counts.

## Staff setup

In Core Services, edit a service and open **Appliances & prices**. Enable only appliances the company actually services. Refrigerators and freezers support either **Fixed price per appliance** or **Price by compressor HP**. Set independent prices and work times for each appliance; aircon prices are not reused. Fractional compressor HP entries such as `1/8` are accepted and stored as normalized numbers. Existing profiles without a pricing mode continue to use their saved fixed price. On October 13, 2026, user-approved sample HP tables were added to Freon Recharging and Leak Testing for refrigerators and freezers; see [Refrigeration HP seed](refrigeration-hp-seed.md). Staff can edit these sample prices and work times.

The editor separates Service details, Appliances & prices, and Warranty into tabs. Invalid fields open the correct tab before showing the error. Disabled appliance settings do not block the form. The save footer stays visible while the body scrolls, and duplicate saves are blocked. The edit script's DOM-ready listener was corrected so it registers without a runtime error.

Customers can select a configured compressor HP for refrigerator/freezer services. Fixed-price tasks do not require HP. Services priced by HP are unavailable until a matching size is selected; an inspection action opens Repair Service when the customer does not know the rating. Prices and durations are checked against the matching appliance catalog on the server.

For jobs whose price depends on inspection, leave direct core booking disabled and offer Repair Service for inspection and a reviewed quote. Pump down and system reprocess must not be enabled for every refrigeration model without staff confirming the scope. Aircon relocation reuses the appliance details already entered and expands nearby/different-address choices in the service step. Its guided two-location map retains the existing staff quote rules; see [Guided relocation booking](guided-relocation-booking.md).

Project work orders bundle all selected core tasks for each shared appliance, add their durations, and include the service names in their checklist. Unit completion and aftercare count the physical appliance once. When compressor HP is provided, it remains part of the saved appliance details, including aftercare.

## Verification

Mocked tests cover authoritative catalog prices, unsupported appliances, changed prices, forged group identities, different quantities/details, duplicate tasks, physical limits, duration-based project classification, schema persistence, project task preservation and aftercare deduplication. Refrigeration tests cover fractional HP, duplicate sizes, independent prices/work times, missing or forged HP, mixed fixed/HP tasks and old catalog compatibility. Browser checks use the real admin template with intercepted saves and the real customer form and booking payload functions at 1440, 390 and 320 pixels. They do not create live bookings or change payments.
