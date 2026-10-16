# Customer service prices

Repair inspection fees come from Service Categories. A unit's inspection-fee
override takes precedence over the company default, including an explicit zero.
The booking form shows the fee on appliance cards, during appliance setup and on
the inspection service. Travel is charged separately once per visit; repair labor
and parts are quoted after inspection. Staff-identification requests display a
pending fee until staff confirms the appliance and price.

On October 17, 2026, the owner confirmed that missing split-suspended and cassette
rates should use the same service's saved split-type prices and work times.
`ApplianceServices.airconHpOptions` implements that rule in browser and server
pricing. Separate valid saved prices, including free rates, take precedence.
Missing HP sizes are not estimated, and other appliance types do not inherit this
rule. Invalid saved negative prices remain unavailable for staff correction.

`effectiveAirconTypes` exposes these effective tables in customer selections and
the Core Services editor. Staff see a Split-type rate label on inherited rows.
Saving that editor creates separate prices; future split-price changes then apply
only to capacities without their own saved prices. This rule changes new catalog
pricing, not existing booking or order price snapshots.

The optional HP expansion script still produces proposals for capacities without
a saved source price. Its exact split-type matches follow the approved rule, but
estimated additional capacities require the existing proposal review process.
