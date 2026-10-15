# IT evaluation fixes

Implemented on 14 October 2026. Existing walk-in booking edits were preserved.

## Customer purchases

- Product list, product detail, cart, and order submission use the same availability rules. Quantity determines stock-derived states; inactive products, discontinued products, coming-soon products, and store-only products remain restricted.
- Requests validate variant IDs and whole-number quantities. Repeated cart additions account for the quantity already in the cart and explain the remaining stock.
- Cart writes detect concurrent changes. The product list prevents duplicate clicks while an add request is pending, and the detail page initially selects an available configuration.
- Failed requests retain useful validation messages and handle expired sessions, unavailable servers, network failures, non-JSON responses, and timeouts.

## Forms and account activity

- Required fields receive visible indicators. Registration and Google signup display server validation errors on the form.
- Address validation uses the same PSGC catalog as the dropdowns, verifies the province/city/barangay hierarchy, and stores canonical names. Postal codes require four digits. Unavailable catalogs return a retryable error; a recent cached catalog can cover a short outage.
- Unchanged profiles return `changed: false` without a database update or audit event. Save buttons track edits.
- Leave requests require real calendar dates starting today or later in Philippine time. Pending and approved overlapping leave requests are rejected.
- Password login updates `lastLogin`, matching OTP and Google login. Profile timestamps display Philippine time.

## Staff operations

- Invoice queries paginate, search, and filter in MongoDB. The page shows retryable failures and clears its loading state. Existing invoice-number conventions are retained.
- Payment actions respect permissions in the UI; server checks remain enforced. Permission errors are presented in plain language.
- Assignment actions handle non-JSON gateway responses. Optional external AI recommendations are fetched through their existing endpoint rather than delaying repair assignment.
- Reviewed staff filter controls share sizing, and the new modals share spacing.

## Inventory import

Use **CSV template** and **Import products** on the aircon inventory page. Each row represents one HP variant; matching model and brand rows are grouped into a product.

Limits: 1 MB, 500 variant rows, and 100 products. Required columns are `modelLine`, `brand`, `category`, `capacity`, `sellingPrice`, and `quantity`. The template contains the supported optional columns and examples. Serial numbers use `|` as their separator.

The preview validates types, prices, quantities, allowed product types and sales channels, duplicate capacities, SKUs, barcodes, and serial numbers. Existing products are never overwritten. New brand/category names are created on import. A signed, expiring preview binds the exact file to the user. Commit rechecks current inventory and reports results per product. Database work is limited to three products at a time.

Endpoints use the existing inventory API prefix, either `/api/admin/hvac` or `/api/secretary/hvac`:

- `GET /import/template`
- `POST /import/preview` — multipart field `csv`
- `POST /import/commit` — multipart fields `csv` and `previewToken`

## Payroll templates and bulk drafts

Use **Templates** to create, edit, or archive recurring allowances and deductions. Built-in names are available for individual entry; their amounts default to zero. Saved template changes do not alter existing payroll records.

Use **Bulk drafts** to select up to 25 employees, dates, and saved template amounts. Calculate and review before creating drafts. The server uses the existing attendance, effective compensation, overlap, calculation, and audit rules. It rechecks the reviewed calculation and rejects changes to attendance, compensation, or template amounts. Approval, exception authorization, separation of duties, and payment recording retain their existing controls.

Admin-only endpoints:

- `GET /api/payroll/templates`
- `POST /api/payroll/templates`
- `PATCH /api/payroll/templates/:id`
- `DELETE /api/payroll/templates/:id` — archives the template
- `POST /api/payroll/bulk/preview`
- `POST /api/payroll/bulk/create`

Batch requests contain `employeeIds`, `templateIds`, `periodStart`, `periodEnd`, `payDate`, and optional `notes`. Creation also requires the returned `previewToken`.

## PDF reports

Sales/payments, service, order, and stock reports have **Export PDF**. PDFs contain server-calculated summaries and detail tables, preserve selected filters, and require the existing report permissions. Generation uses [PDFKit](https://pdfkit.org/docs/getting_started.html); no spreadsheet software or print dialog is required. Very large detail tables explicitly indicate their 2,000-row export limit.

## Verification

- Regression tests cover availability, cart limits and concurrency errors, forged address choices, typed registration input, unchanged profiles, leave date boundaries, gateway and permission responses, invoice recovery, CSV validation, import preview binding, payroll selection and preview binding, login timestamps, assignment latency, and multipage PDFs.
- Isolated Edge browser checks passed 1 HP and 3 HP Add to Cart on the product list and detail page, Buy Now advancing past configuration on the product list and opening checkout from the detail page, template creation/editing, payroll review invalidation and draft creation, CSV review/error/import flows, invoice gateway recovery and pagination, filtered PDF downloads, and a mobile payroll layout, with no JavaScript exceptions. These checks use memory-only API fixtures and local replacements for external modal/date widgets.
- Read-only database checks verified the actual `hvac_products` catalog and executed the new invoice aggregation. No live carts, orders, inventory, payroll, or payment records were created for verification.
- Initial full suite: 1,960 tests, 1,937 passed, 23 failed. All 23 failures reproduced on the original checkout plus the user's existing edits. Those failures have since been resolved: the final full suite passes all 1,961 tests. All 19 IT regression tests still pass. See [test failure resolution](test-failure-resolution.md) for the code fixes, fixture corrections, and verification.

Restart or redeploy the application to load the changes. `.env` was not modified.
