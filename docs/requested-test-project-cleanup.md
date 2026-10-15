# Two live test projects and refund-report corrections

Status: **prepared and tested locally; not applied to the live database**. The configured external connection was refused (`ECONNREFUSED`). No live records were changed. Use the application's internal Dokploy connection; reopening a public MongoDB port is unnecessary.

## Requested scope

The system owner identified exactly these records as test projects:

| Project ID | Customer | Repair units |
| --- | --- | ---: |
| `6acd3b47678aa45bd94a7354` | Abby Oseo | 7 |
| `6accb39899a4f85a0ecba22e` | Joshua Javier | 40 |

The cleanup archives these projects from the active large-scale project list and cancels their linked bookings, work orders, daily assignments and technician assignments. Original records are retained for recovery. It does not hard-delete financial history.

Linked test payments and expenses receive the internal `testDataExcludedAt` and `testDataExclusionReason` metadata. Sales and Payments queries exclude those marked records. Payment amounts, payment statuses, refund amounts and refund statuses remain unchanged. The metadata is deliberately not a writable Mongoose schema field; it is written by the restricted cleanup script. A regression check verifies that the query predicate survives Mongoose casting.

Uncollected project reservations are released only when the corresponding reserved counter is sufficient. An insufficient or missing counter aborts the transaction. Shared daily-kit records, checked-out tools, picked-up materials, physical stock quantities, unrelated payments and payroll remain intact. Issued equipment must still go through the normal return/receipt process; marking a project as test data does not put a physical tool back in the warehouse.

The script refuses missing/mismatched identities, changed unit counts, completed units, shared bookings or linked product purchases. It writes and verifies a private EJSON backup, checks that related records still match the backup inside the transaction, logs the archive, and verifies the result. Repeating an already completed cleanup does not release stock twice.

## Run inside Dokploy

The workspace changes do not change the running site automatically. If Dokploy builds from GitHub, commit and push the changed files and the new scripts to its configured branch, then deploy that commit. Redeploying the existing remote commit does not include uncommitted or untracked local files. Restart the application with the updated source so its loaded reporting modules and templates match.

Seeing either project on a web page is not the cleanup command's output. The command must return JSON with a `mode` field. A successful deployment alone also does not remove records: the separate cleanup must run successfully.

1. Deploy the updated application code, including `server/scripts/archive-requested-test-projects.js`, `server/scripts/auditProjectTestData.js`, `server/utils/enterpriseRevenue.js`, `server/utils/revenueAnalytics.js`, and `server/views/pages/admin/Reports/RevenueReports.ejs`, together with the other dependencies of the current application changes.
2. Open the **web application service** in Dokploy, then its application/container terminal. Use the application service, rather than the MongoDB service. The application already has its internal database settings; do not paste a database password or connection string.
3. In the application root (the folder containing `package.json` and `server`), run this read-only preview:

   ```sh
   node server/scripts/archive-requested-test-projects.js
   ```

   It must list only the two project IDs above. It also shows linked payment totals, completed versus requested refunds, reservations, and custody records. A mismatch stops the script without changing records.

4. Apply the already requested cleanup:

   ```sh
   node server/scripts/archive-requested-test-projects.js --apply
   ```

   The output must say `"mode": "archived"` or `"mode": "already-archived"`. A database without transaction support will abort; do not work around this with individual manual deletes.

5. Copy the EJSON backup reported in the output off the application container before another deployment. From the Dokploy **server** terminal, find the web container:

   ```sh
   docker ps --format '{{.ID}}  {{.Names}}'
   ```

   Substitute its ID and the exact absolute backup path printed in step 4:

   ```sh
   docker cp WEB_CONTAINER_ID:/EXACT/PRINTED/BACKUP.ejson ./requested-test-projects-recovery.ejson
   ```

   Keep this file private. It contains original customer and financial records. Download a copy to your own computer as well. The original records remain archived in the database, so a container restart does not restore them to the active list.

6. Refresh the large-scale projects list and Sales and Payments report. Reporting caches expire after about 30 seconds per running application process. The cleanup process cannot directly clear caches inside other running containers.

If the report still says **Completed work net of period refunds** or **0.0% profit** for negative net sales, first hard-refresh with Ctrl+Shift+R. If those labels remain, inspect which application version is serving the request. The updated report says **Completed work less completed period refunds** and **Margin unavailable** when net sales are nonpositive. Multiple running application instances must all use the updated build.

To check source deployment without connecting to MongoDB, run this in the web application's root directory:

```sh
node -e 'const f=require("fs");const check=(p,s)=>f.existsSync(p)&&f.readFileSync(p,"utf8").includes(s);console.log(JSON.stringify({cleanupScript:f.existsSync("server/scripts/archive-requested-test-projects.js"),refundFix:check("server/utils/enterpriseRevenue.js","function completedRefund"),reportQueries:check("server/utils/revenueAnalytics.js","testDataExcludedAt: null"),reportTemplate:check("server/views/pages/admin/Reports/RevenueReports.ejs","Margin unavailable")},null,2))'
```

All four values should be `true`. `false` identifies missing source updates or the wrong working directory. This check does not read environment files, credentials or database records. Even after all four values are true, a successful cleanup and an application restart/current build are still required; file presence alone does not prove that an older running process has loaded the changes.

## Investigating the displayed financial totals

The supplied totals imply `29,220 - 925,227 = -896,007` for completed sales net of period refunds. That arithmetic alone cannot prove that the underlying refund records are valid or invalid.

A verified reporting bug was present: cancellation writes a requested `refundAmount` while its `refundStatus` is still `pending`, but the ledger deducted that request immediately and could use the original collection date as its refund date. The corrected ledger counts explicit `completed` refunds only. For historical records without a refund-status field, a refunded payment status or an actual refund timestamp is required. Pending, processing, partial-request and explicit `none` records do not represent completed cash refunds.

Actual completed refunds remain visible, including a genuinely negative reporting period. Negative/zero net sales now make percentage margins unavailable instead of presenting `0.0% profit`. Both the initial HTML and filtered report update use this behavior. Reporting changes do not issue, cancel or settle a refund.

For a read-only audit from the application terminal:

```sh
node server/scripts/auditProjectTestData.js
```

This prints bounded project/refund details and reconciles the default and current-month report ranges. It never prints credentials or proof images and performs no database updates. Its private JSON output is saved under `temp/live-project-refund-audit.json`. A `capped` result requires a larger/paginated audit before claiming a complete reconciliation. Do not publish the output or paste it into a public issue.

## Verification

Eighteen new regression tests cover pending/completed/historical refunds, preserved negative cash flow, the real revenue engine with the supplied figures, query casting, test-data exclusion, exact cleanup scope, dry-run behavior, verified backups, original financial amounts, shared custody, unrelated records, transaction rollback, concurrent changes and idempotent reservation release. The full local suite passes: **2,169 passed, 0 failed**.

Isolated Edge checks passed at **1440px and 390px** for both admin and secretary views, including initial HTML and filtered updates. These use the actual report template with synthetic API responses. Live project/refund counts and final live totals remain unverified until the internal-container commands run.
