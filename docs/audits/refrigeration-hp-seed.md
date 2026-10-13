# Refrigerator and freezer HP catalog seed

`server/scripts/seedRefrigerationHpServices.js` adds separate refrigerator and freezer profiles to the existing Freon Recharging and Leak Testing records. It does not create duplicate service records, change aircon prices, or overwrite an appliance profile already saved by staff.

The sample tables below are demonstration prices, not company-approved rates. Each profile also has an editable work time per HP tier so booking duration calculations use that appliance's service time.

| Compressor HP | Refrigerator recharge | Freezer recharge | Refrigerator leak test | Freezer leak test |
| --- | ---: | ---: | ---: | ---: |
| 1/8 | PHP 650 | PHP 800 | PHP 350 | PHP 400 |
| 1/6 | PHP 700 | PHP 900 | PHP 375 | PHP 450 |
| 1/5 | PHP 750 | PHP 1,000 | PHP 400 | PHP 500 |
| 1/4 | PHP 800 | PHP 1,100 | PHP 450 | PHP 550 |
| 1/3 | PHP 900 | PHP 1,250 | PHP 500 | PHP 650 |
| 1/2 | PHP 1,100 | PHP 1,500 | PHP 600 | PHP 750 |

Preview without saving:

```sh
node server/scripts/seedRefrigerationHpServices.js --sample-prices
```

Save approved sample prices by adding `--apply`. For company prices, use `--prices path/to/prices.json` instead of `--sample-prices`; the JSON object uses the service slugs and appliance profile structure exported as `SAMPLE_PRICES` by the script. Staff can edit saved prices under **Core Services → Edit → Appliances & prices**.

Before writing, the script validates both services and all tiers, saves a recovery snapshot under the ignored `temp/seed-backups` folder, and checks for a writable replica set. Both updates run in one transaction with a guard against concurrent profile changes. It then reads back the saved tables and checks every new HP tier with the customer's pricing function. No booking records or payments are modified.

Mocked tests cover preserving aircon prices, keeping subsequent staff edits, duplicate and archived service rejection, invalid tiers, matching customer/server prices, and grouping both services on the same physical appliance. Tests do not connect to MongoDB.

## Applied seed

On October 13, 2026, the user selected the sample prices above and they were saved to the configured shared Dokploy database (`test`). Two existing services received four appliance profiles, containing 24 HP prices and work times in total. Both records were read back and all new tiers passed customer pricing checks. The deployed public `/api/services` endpoint also returned all four enabled HP profiles with six tiers each. The local application endpoint was unavailable during this check. The recovery snapshot is `temp/seed-backups/refrigeration-hp-2026-10-13T02-48-24-703Z.json`. No existing aircon price tables were updated.
