# CALIDRO RACS: audited architecture

Audit date: **09 October 2026 (Asia/Manila)**. This describes the current working tree, including changes that were present before the audit. Deployment behavior is inferred from checked-in configuration; production was not inspected.

## Open the deliverables

- [Offline visual viewer](index.html): six diagrams, vector SVG downloads, Mermaid downloads, zoom, printing and a searchable list of every model.
- [Data flow and architecture diagrams](DIAGRAMS.md): DFD context/Level 0, Level 1, booking Level 2, sales/payment Level 2, web architecture and system architecture.
- [Complete model audit](MODEL_AUDIT.md): every compiled model, collection, field, reference, enum and index declaration.
- [Audit findings](AUDIT_FINDINGS.md): implementation findings, source evidence, test failures and limits.
- [Source/schema inventory](audit-inventory.json), [model groups](model-groups.json), [test results](test-results.json), [full model reference graph](diagrams/model-references.mmd).

## Coverage and method

The source inventory covers **866** `.js`, `.cjs`, `.ejs` and `.css` files under `server`, including tests and scripts. Dependencies, vendor libraries, images, fonts and user uploads are excluded. It found **64 model-directory JavaScript files**, **63 registered Mongoose models**, **38 route modules**, **15 middleware modules**, **139 utility modules**, **192 EJS templates** and **197 test files**. `BookingStatus.js` exports lifecycle constants rather than a database model.

Every model was loaded and inspected through its compiled Mongoose schema without starting the application or connecting to MongoDB. Source indexing covered all included files; focused implementation review covered entry-point composition, middleware, storage, scheduling, financial writes, provider calls and lifecycle policies. The existing test suite was executed. This is an architecture/schema audit, not a line-by-line security review of every included source file.

No `.env` values, credentials, customer data or live database contents were exported. Environment names in the inventory are extracted from source. Collection/index names represent declarations, not verified live database state. Lexical imports include conditional and lazy branches; they indicate potential reachability rather than execution. Route declarations are file-local and can include aliases or overlapping mounts.

## Architecture conclusion

The application is a **modular monolith**. One Node.js / Express 5 process serves EJS pages and JSON APIs, hosts Socket.IO and chat SSE, and runs background polling jobs. Domain rules live in route implementations, controllers and shared utilities. MongoDB persists operational data, server sessions, operation leases, email jobs and GridFS proofs. No separate Redis, message broker, independently deployed domain services or tenant discriminator establishing multi-tenancy was found in the audited runtime configuration.

The four account roles are `customer`, `admin`, `secretary` and `technician`, declared in [User.js](../../server/models/User.js). POS is a staff workflow. The technician interface consists of browser pages; a separate native mobile application is not established by the audited code.

[render.yaml](../../render.yaml) declares one Render Node web service and a `/ready` health check. The hosting proxy is expected to terminate HTTPS. Live host configuration, replicas, disks, backups and provider availability were not verified.

## Web request path

1. A browser requests a page, asset or API through the HTTPS hosting proxy.
2. [server/index.js](../../server/index.js) sets headers, compression, telemetry and proxy trust. Public assets and health probes have early paths that avoid session/user database queries.
3. Admission controls run before costly parsing and session lookups. Mutations under `/api` and `/appointments` pass trusted-origin checks. Auth and chat use smaller body budgets than the global legacy 10 MB parser.
4. `express-session` persists sessions through `connect-mongo`, using the shared Mongo client. Current-user resolution supports the `auth_token` JWT cookie and server-session fallback.
5. Page/API guards enforce account state, roles, permissions and selected record ownership/assignment rules before domain operations.
6. **EJS executes on the server.** HTML, CSS and browser JavaScript are sent to the client. Client scripts then use JSON endpoints, chat SSE tokens and Socket.IO subscriptions.

The PayMongo webhook is mounted before normal JSON parsing and browser trusted-origin checks. It receives raw request bytes for signature validation and forms a distinct provider entry point; earlier HTTP controls still apply.

## Logical stores: all 63 models

These are logical groups in one database, not ten deployed databases. Each model is assigned once for inventory completeness; processes can use several groups. `User.role` associates accounts with permission definitions by role name, rather than an ObjectId reference to `Role`.

| Process / primary store | Models |
| --- | --- |
| 1.0 Identity / D1 | User, Role, AuthSession, TrustedDevice, LoginHistory, FailedLoginAttempt, Technician, Secretary |
| 2.0 Catalog / D2 | CoreService, RepairService, Service, ServiceCategory, HVACProduct, Brand, Category |
| 3.0 Booking and dispatch / D3 | BookingService, Assignment, TechnicianSchedule, NonWorkingDay, UnitAssistanceRequest, RelocationRequest, ServiceReport |
| 4.0 Stock and resources / D4 | Inventory, Tool, ToolAssignment, StockReservation, StockAdjustment, ServiceToolUsage, EquipmentAssignment, EquipmentUsageLog, DailyKit, PartsRequest |
| 5.0 Project delivery / D5 | Project, WorkOrder, DailyAssignment, ProjectMaterial, ProjectIssue, ProjectResourcePurchase, ProjectWorkSubmission |
| 6.0 Sales / D6 | AirconCart, Order, Purchase, WalkInSale |
| 7.0 Finance / D7 | Payment, Payroll, Expense, EmployeeCompensation |
| 8.0 Aftercare and feedback / D8 | CustomerAsset, MaintenanceSchedule, WarrantyClaim, ProductReturn, ProductRefund, ProductReturnMovement, Rating |
| 9.0 Attendance and leave / D9 | TechnicianAttendance, SecretaryAttendance, LeaveRequest |
| 10.0 Reports, settings and assistance / D10 | SiteSetting, ActivityLog, Notification, EmailOutbox, EmailDeliveryLog, OperationLock |

Additional stores are **D11 GridFS** (`paymentProofs.files/chunks` and `completionProofs.files/chunks`), `connect-mongo` sessions, and **D12 runtime/local storage** (bounded chat state, caches, admission counters, temporary files, legacy uploads and logs). These do not add Mongoose models to the total. Cloudinary is external public image storage.

### Cross-process flows and additional store reads

Level 1 emphasizes actor/process/store exchanges. The following contracts supply cross-process connections and shared-store reads. Provider exchanges balance the context diagram. Level 2 diagrams are selected decompositions of booking and sales/payment, rather than exhaustive endpoint diagrams.

| Flow | Data |
| --- | --- |
| 1.0 → protected processes | Verified account, role and permission outcome; D1 staff/customer data |
| 2.0 → 3.0 / 6.0 | Service/product definitions, duration, price, variant and availability; D2/D4 data |
| 3.0 ↔ 7.0 | Booking-linked payment request and verification outcome; D7 ledger |
| 3.0 ↔ 4.0 | Resource needs, reservations, kit and usage availability; D4 records |
| D1 / D9 / D10 → 3.0 | Technician eligibility, leave, settings and capacity leases |
| 3.0 → 5.0; 5.0 ↔ 4.0 | Source booking; project materials, purchases, allocation and usage |
| 6.0 ↔ 7.0 / 4.0 | Order payment/outcome; selected quantities and conditional stock changes |
| 3.0 / 6.0 → 8.0 | Completed work/order, asset and warranty eligibility |
| 8.0 ↔ 7.0 / 4.0 | Original payment, refund posting and return stock movements |
| 9.0 → 7.0 | Approved attendance and compensation inputs |
| Domain processes → 10.0 | Business events, audit data, notification/email requests |
| D1–D9 → 10.0 | Date-bounded operational and financial reporting inputs |

## Module traceability

| Domain | Main routes | Representative policies / utilities |
| --- | --- | --- |
| Pages / identity | pages, authRoutes, nested secureAuth, userRoutes, customerNavRoutes | currentUser, authenticate, pageAuth, requirePermission, accountState, trustedDevices |
| Catalog | serviceRoutes, productRoutes, hvacApi, hvacSecretaryApi, publicCompanyRoutes | coreServicePricing, repairModelPolicy, serviceCatalogPayload, hvacSerialNumbers |
| Booking / dispatch | bookingRoutes, bookingRoutesNew, bookingFlow, scheduleRoutes, appointmentRoutes, appointmentManagement | bookingSubmissionWrite, bookingLifecycle, bookingPolicy, bookingDateTime, enterpriseSchedulingEngine, assignmentPlanner |
| Special quotations | unitAssistanceRoutes, relocationRoutes | aftercarePolicy, relocationChecklist, bookingSubmissionWrite |
| Sales / POS | airconCartRoutes, orderRoutes, posRoutes | orderCheckoutWrite, orderCheckoutPolicy, orderPreparation, orderAssignmentPlanner, orderScheduleCapacity |
| Stock / equipment | inventoryRoutes, equipmentReturnRoutes, staff/technician routes | toolUsageManagement, dailyKitService, equipmentAssignmentLifecycle, equipmentReturnPolicy |
| Projects | projectRoutes, technician/staff routes | projectScheduler, projectAllocation, projectWorkOrderPlanning, projectResourcePlanning, projectDailyKitPlanning, projectWorkSubmission |
| Finance / payroll | paymongoRoutes, payrollRoutes, staff payment endpoints | paymentController, paymentPolicy, remittancePolicy, payrollPolicy, revenueRecognition |
| Aftercare | maintenanceRoutes, warrantyRoutes, productReturnRoutes, ratingApi | maintenanceLifecycle, warrantyLifecycle, warrantyClaimService, serviceWarrantyPolicy, productReturnPolicy |
| Staff | adminApi, secretaryApi, technicianApi | staffLifecycle, attendanceSecurity, technicianOvertimePolicy, operationsDetail |
| Reporting | Admin/secretary report endpoints | reportCenter, reportCache, enterpriseRevenue, revenueAnalytics, decisionIntelligence, customerPerformance |
| Alerts / AI | notifications, chatRoutes, technician AI endpoint | notify, emailOutbox, mailer, chatIntent, chatServiceKnowledge, aiTechnicianAssistant, socketTrafficProtection |
| Geography / calendar | geocodingRoutes, psgcRoutes, holidayRoutes | googleCalendarSync, googleCalendarService, nagerDateService, orderCheckoutPolicy |

`adminApi` also serves `/api/secretary/operations`; appointment/equipment routes are shared with secretary mounts. Both booking route modules mount under `/api/bookings`, so registration order matters. The machine-readable inventory records every route module and its declarations with source line numbers.

## Persistence and consistency

- `BookingService` embeds service items and history, with dynamic references to `CoreService` or `RepairService`. Snapshots coexist with canonical account, assignment and report links.
- HVAC stock is in `HVACProduct.variants`, generic product stock in `Inventory`, and tools/field consumables in `Tool`. `StockReservation` reserves Tool stock for booking items. Product checkout uses conditional product/variant stock decrements.
- `orderCheckoutWrite` and `bookingSubmissionWrite` use MongoDB transactions when supported, with conditional compensating cleanup on standalone deployments. This fallback does not cover every route: other cancellation/refund paths use direct transactions.
- `OperationLock` supplies expiring leases for selected workflows. It does not renew a lease during long work or serialize the whole application.
- `Payment` records booking/order/project/work-order links, amount, events, evidence, collection/remittance and refund fields. It enables optimistic concurrency. Payment, booking, assignment and order have distinct lifecycle vocabularies.
- `dataLifecycle` retains operational, financial and audit records with archive/void/cancel/reverse policies. Temporary authentication/outbox records have selected TTL indexes. One retention policy does not apply to all collections.

## External integrations

| Provider | Evidence / behavior |
| --- | --- |
| Google OAuth / reCAPTCHA | googleAuthController, authController and auth scripts; identity redirects and configuration-dependent challenge verification |
| Brevo / SMTP | mailer, emailOutbox, EmailDeliveryLog; production defaults to encrypted MongoDB email jobs and configured provider delivery |
| Cloudinary / GridFS | productImageStorage for public catalog images, with local fallback; paymentProofStorage and completionProofStorage for durable private evidence |
| PayMongo | Raw signed webhook and retained source-charge handling. `/api/paymongo/checkout-session` returns HTTP 410; online card helper code remains but booking/order routes do not call it |
| Geoapify / Nominatim / PSGC | geocodingRoutes and psgcRoutes; autocomplete, geocoding and Philippine administrative hierarchy |
| OSRM / Esri | Checkout policies and browser scripts; routing calls and browser map imagery/label tiles |
| Google Calendar / Nager.Date | googleCalendarSync, googleCalendarService, holiday routes; optional event synchronization and public holiday data |
| Gemini / Groq / OpenRouter / Tavily | chatRoutes and aiTechnicianAssistant; configuration-dependent AI/search with fallback and bounded work |
| QR image service | Retained repair-request browser code sends encoded QR contents to an external image URL; local QR code code also exists |

An implemented provider adapter is not proof of configured credentials, live subscription, current model availability or successful external operation. No external provider requests were made for this audit.

## Workers and real-time behavior

The web process starts email-outbox, overdue, maintenance, equipment-return and delay workers after database readiness. Additional timers in `server/index.js` handle assignment expiry and reminders. Some workers use atomic claims and deduplication fields; multiple web replicas still require a workflow-by-workflow ownership audit. Outbox delivery can repeat after a crash between provider acceptance and the database success update.

Socket.IO authenticates accounts and joins scoped user/customer/technician rooms and a staff room. GPS handlers check technician identity and booking ownership before customer publication. No distributed Socket.IO adapter is configured. Chat history, report caches and admission counters are bounded process-local memory; they are lost on restart, unlike MongoDB sessions and business records.

## Reproduce

From the repository root:

```powershell
node scripts/audit-architecture.cjs
node server/tests/run-all.js > temp/architecture-audit-tests.log 2>&1
node scripts/build-architecture-docs.cjs
```

The audit generator writes documentation without loading `.env`, starting the app or connecting to the database. The audit date is fixed in the script and must be updated for a later report. Existing tests control their own test setup.
