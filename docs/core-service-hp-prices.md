# Complete the Core Services HP price tables

The operator-only `expand-core-hp-prices.js` script covers 0.5, 0.75, 1, 1.5, 2,
2.5, 3, 3.5, 4, 4.5 and 5 HP for every existing aircon type in every active
aircon core service. It also adds split-suspended and cassette tables where those
requested types are absent. Archived services and refrigeration profiles remain
unchanged. No prices are updated automatically on deployment.

Every saved price is retained. Under the owner's October 17 pricing rule, missing
suspended/cassette capacities with an exact saved split-type match use that
price and work time. Customer booking already applies this rule through the
shared pricing helper; the script is not required to enable those matches.

Other missing HP prices are **proposals** calculated
from that type's existing price trend and rounded to the nearest PHP 50. Where
an entire suspended/cassette table is absent, the proposal uses that service's
split-type table as its base. New durations follow saved duration trends and are
rounded up to 15 minutes. This calculation is not evidence of a company-approved
rate or a manufacturer's available aircon capacities. Staff must review the
proposed price and suitability for each supported unit before applying it.

After deployment, open a new Dokploy application terminal:

```sh
cd /app
node server/scripts/expand-core-hp-prices.js --prepare
```

This validates every proposed service against the actual CoreService model and
saves a private price CSV, compressed recovery file and checksum. It makes no
database changes. Download `proposalDownloadPath`, `backupDownloadPath` and
`checksumDownloadPath` through the signed-in admin browser. Prefix those paths
with the site's address. Review the CSV's proposed rows; the existing rows are
labeled separately. If rates need changing, enter the company's rates in Core
Services and prepare again. Editing the CSV alone does not change the prepared
update.

After reviewing the exact prices, apply the printed backup path within 24 hours:

```sh
node server/scripts/expand-core-hp-prices.js --apply --backup /app/temp/EXACT-FILE.ejson.gz
```

The command compares the current catalog with the recovery snapshot and updates
all prepared price tables in one MongoDB transaction. Concurrent catalog changes,
a corrupt recovery file or any failed write prevent partial changes. A completion
marker prevents accidental repeated application. Existing bookings, orders,
payments and stock do not change; their saved prices remain historical snapshots.
Maintenance mode is unchanged. Reopen the service selection to load the new rates.

To recover the original price tables using the same private file:

```sh
node server/scripts/expand-core-hp-prices.js --restore --backup /app/temp/EXACT-FILE.ejson.gz
```

Recovery refuses to overwrite price tables edited by staff after the update.
Keep downloaded private recovery files outside public/uploads and source control;
container storage may be replaced on redeployment.
