# Error & Timestamp Reference

## Table of Contents

1. [HTTP Status Codes](#1-http-status-codes)
2. [Error Response Format](#2-error-response-format)
3. [Custom Error Codes](#3-custom-error-codes)
4. [Rate Limiting](#4-rate-limiting)
5. [Security Errors](#5-security-errors)
6. [Timestamp Formats](#6-timestamp-formats)
7. [TTL & Expiration Values](#7-ttl--expiration-values)

---

## 1. HTTP Status Codes

| Code | Meaning | When Triggered |
|------|---------|----------------|
| **400** | Bad Request | Invalid input, missing required fields, validation failures, policy violations |
| **401** | Unauthorized | Missing or expired JWT/session token |
| **403** | Forbidden | Authenticated but insufficient permissions for the requested resource |
| **404** | Not Found | Requested resource (user, booking, order, etc.) does not exist |
| **409** | Conflict | Duplicate record (e.g., email already registered, slot already booked) |
| **410** | Gone | Resource permanently removed (e.g., completed booking no longer editable) |
| **422** | Unprocessable Entity | Syntactically valid but semantically incorrect input |
| **429** | Too Many Requests | Rate limit exceeded or OTP throttling |
| **500** | Internal Server Error | Unhandled database or system errors |
| **503** | Service Unavailable | Site in maintenance mode or external service (reCAPTCHA, email) failure |

---

## 2. Error Response Format

### Standard JSON Shape

Returned by the global error handler (`server/index.js:518-528`):

```json
{
  "error": "Human-readable error message",
  "code": "OPTIONAL_ERROR_CODE",
  "unavailable": ["optional array of unavailable items"]
}
```

**Production behavior:** 5xx error messages are replaced with `"Internal server error"` to hide internals. 4xx messages are passed through.

### Progress Rate Limiter Response (429)

Returned by `server/controllers/secureAuthController.js:171-191`:

```json
{
  "error": "Too many failed login attempts (cycle 2). Try again in 5 minutes.",
  "retryAfter": 300,
  "currentCycle": 2,
  "showPopup": true,
  "popupTitle": "Account Temporarily Locked",
  "popupMessage": "Too many failed login attempts..."
}
```

### Maintenance Mode Response (503)

Returned by `server/middleware/maintenanceMode.js:14-17`:

```json
{
  "error": "System is under maintenance. Please try again later.",
  "maintenance": true
}
```

### Permission Denied Response (403)

Returned by `server/middleware/authenticate.js:101-105`:

```json
{
  "error": "Forbidden: insufficient permission",
  "code": "INSUFFICIENT_PERMISSION",
  "requiredPermission": "admin:settings:write"
}
```

---

## 3. Custom Error Codes

### Attendance Security (`server/utils/attendanceSecurity.js`)

| Code | HTTP | Description |
|------|------|-------------|
| `QR_INVALID` | 400 | QR code data is malformed or unreadable |
| `QR_EXPIRED` | 400 | QR code has passed its TTL (default 45s) |
| `LOCATION_REQUIRED` | 400 | GPS location not provided with attendance |
| `LOCATION_INACCURATE` | 400 | GPS accuracy exceeds max threshold (default 100m) |
| `LOCATION_STALE` | 400 | Location timestamp older than max age (default 120s) |
| `OUTSIDE_GEOFENCE` | 400 | Device outside allowed geofence radius (default 250m) |
| `OUTSIDE_WORKSITE_GEOFENCE` | 400 | Device outside worksite boundary |

### Remittance Policy (`server/utils/remittancePolicy.js`)

| Code | HTTP | Description |
|------|------|-------------|
| `REMITTANCE_INVALID` | 400 | Default remittance validation error |
| `REMITTANCE_METHOD_REQUIRED` | 400 | Payment method not specified |
| `REMITTANCE_NOTES_REQUIRED` | 400 | Required notes field missing |
| `REMITTANCE_PROOF_REQUIRED` | 400 | Proof of payment not uploaded |
| `REMITTANCE_REFERENCE_REQUIRED` | 400 | Transaction reference number missing |
| `REMITTANCE_ACTION_INVALID` | 400 | Unknown remittance action attempted |
| `REMITTANCE_STATE_CONFLICT` | 400 | Remittance already in terminal state |
| `REMITTANCE_PAYROLL_REVERSAL_REQUIRED` | 400 | Cannot reverse without payroll adjustment |
| `REMITTANCE_EVIDENCE_MISSING` | 400 | Supporting evidence not attached |
| `REMITTANCE_REASON_REQUIRED` | 400 | Reversal reason not provided |
| `REMITTANCE_OVERRIDE_NOTES_REQUIRED` | 400 | Override justification missing |
| `REMITTANCE_RESOLUTION_CONFLICT` | 400 | Resolution conflicts with existing state |
| `REMITTANCE_RESOLUTION_REQUIRED` | 400 | Resolution action not specified |
| `REMITTANCE_RESOLUTION_NOTES_REQUIRED` | 400 | Resolution notes missing |
| `REMITTANCE_FOLLOW_UP_INVALID` | 400 | Invalid follow-up action |

### Order Checkout (`server/utils/orderCheckoutPolicy.js`)

| Code | HTTP | Description |
|------|------|-------------|
| `ORDER_CHECKOUT_INVALID` | 400 | Default checkout validation error |
| `ORDER_LOCATION_REQUIRED` | 400 | Delivery location not provided |
| `ORDER_GCASH_SENDER_INVALID` | 400 | GCash sender name doesn't match account |
| `ORDER_ITEMS_INVALID` | 400 | Cart items missing or invalid |
| `ORDER_ITEM_QUANTITY_INVALID` | 400 | Item quantity below 1 or exceeds stock |
| `ORDER_ITEM_DUPLICATE` | 400 | Same product added twice |
| `ORDER_UNIT_LIMIT_EXCEEDED` | 400 | Exceeds maximum units per order |
| `ORDER_PICKUP_DATE_INVALID` | 400 | Pickup date is in the past or invalid |
| `ORDER_PICKUP_STORE_CLOSED` | 400 | Pickup date falls on a closed day |
| `ORDER_FULFILLMENT_INVALID` | 400 | Unknown fulfillment method |
| `ORDER_PAYMENT_METHOD_INVALID` | 400 | Unsupported payment method |
| `ORDER_DELIVERY_ADDRESS_REQUIRED` | 400 | Delivery address missing for delivery orders |
| `ORDER_CONTACT_INVALID` | 400 | Contact number format invalid |
| `ORDER_DELIVERY_DATE_INVALID` | 400 | Delivery date is in the past |
| `ORDER_TIME_REQUIRED` | 400 | Preferred time slot not selected |
| `ORDER_DELIVERY_RATE_INVALID` | 400 | Delivery rate calculation failed |

### Customer Invitation (`server/utils/customerAccountInvitation.js`)

| Code | HTTP | Description |
|------|------|-------------|
| `CUSTOMER_INVITATION_INVALID` | 400 | Default invitation validation error |
| `CUSTOMER_ACCOUNT_CONSENT_REQUIRED` | 422 | Customer consent not given |
| `CUSTOMER_EMAIL_REQUIRED` | 400 | Email address not provided |
| `CUSTOMER_ACCOUNT_UNAVAILABLE` | 400 | Account creation blocked (e.g., email taken) |

### Technician Assignment & Job Codes

| Code | HTTP | Description |
|------|------|-------------|
| `BOOKING_BALANCE_REQUIRED` | 400 | Outstanding balance must be paid before dispatch |
| `ATTENDANCE_RATE_LIMITED` | 429 | Too many attendance attempts (1 per minute) |
| `TRUSTED_DEVICE_REQUIRED` | 400 | Attendance from unrecognized device |
| `ADMIN_OVERRIDE_REQUIRED` | 400 | Requires admin approval to proceed |
| `ACTIVE_JOB_REMAINING` | 400 | Cannot start new job while previous is incomplete |
| `REMITTANCE_REQUIRED` | 400 | Cash remittance must be submitted |
| `EXPENSE_CONFIRMATION_REQUIRED` | 400 | Expense report pending confirmation |
| `SCHEDULE_MISSED` | 400 | Technician missed scheduled attendance window |
| `AI_REVIEW_REQUIRED` | 400 | Service report needs AI review before submission |
| `NO_SHOW_EVIDENCE_REQUIRED` | 400 | Evidence required for no-show classification |
| `WAITING_PERIOD_NOT_ELAPSED` | 400 | Action taken before allowed waiting period |
| `NO_SHOW_ADMIN_DECISION_REQUIRED` | 400 | Admin decision needed for no-show resolution |
| `NO_SHOW_REVIEW_REQUIRED` | 400 | No-show requires review before status change |
| `COMPLETION_PROOF_REQUIRED` | 400 | Photo/video proof required to mark complete |
| `DAILY_KIT_REQUIRED` | 400 | Daily kit not yet submitted for today |
| `DAILY_KIT_DELTA_REQUIRED` | 400 | Kit changes require delta submission |
| `CORE_SERVICE_PENDING` | 400 | Core service tasks incomplete |
| `PHASE_ONE_PAYMENT_REQUIRED` | 400 | First phase payment required to proceed |
| `INSPECTION_FEE_REQUIRED` | 400 | Inspection fee must be paid |

### Scheduling & Slots

| Code | HTTP | Description |
|------|------|-------------|
| `SLOT_CONFLICT` | 400 | Time slot overlaps with existing booking |
| `RESCHEDULE_REQUIRED` | 400 | Original slot no longer valid, reschedule needed |
| `SLOT_UNAVAILABLE` | 400 | Requested slot has no available technicians |

### Order Lifecycle

| Code | HTTP | Description |
|------|------|-------------|
| `ORDER_CHECKOUT_RATE_LIMITED` | 429 | Too many checkout attempts |
| `ORDER_PAYMENT_PROOF_INVALID` | 400 | Payment proof image unreadable |
| `ORDER_SCHEDULE_PASSED` | 400 | Scheduled date/time has already passed |
| `ORDER_SERIAL_NUMBERS_REQUIRED` | 400 | Serial numbers required for serialized items |
| `ORDER_SCHEDULE_REQUIRED` | 400 | Schedule not set before dispatch |
| `ORDER_PREPARATION_REQUIRED` | 400 | Preparation not completed |
| `ARRIVAL_PROOF_REQUIRED` | 400 | Arrival photo not uploaded |
| `START_PROOF_REQUIRED` | 400 | Work start photo not uploaded |
| `ORDER_CONSUMABLE_USAGE_INVALID` | 400 | Consumable usage data invalid |
| `ORDER_ACCEPTANCE_WINDOW_ACTIVE` | 400 | Customer acceptance window still open |
| `ORDER_PAYMENT_NOT_VERIFIED` | 400 | Payment verification pending |
| `ORDER_ASSIGNMENT_PLAN_STALE` | 400 | Assignment plan outdated, needs refresh |

### HVAC Product Management

| Code | HTTP | Description |
|------|------|-------------|
| `HVAC_SERIAL_ALREADY_ASSIGNED` | 409 | Serial number already linked to another product |
| `HVAC_SKU_ALREADY_ASSIGNED` | 409 | SKU already in use |
| `HVAC_BARCODE_ALREADY_ASSIGNED` | 409 | Barcode already assigned |
| `HVAC_DUPLICATE_VALUE` | 409 | Duplicate value in a unique field |
| `HVAC_PRODUCT_ARCHIVED` | 410 | Product has been archived |

### Staff & Inventory Lifecycle

| Code | HTTP | Description |
|------|------|-------------|
| `STAFF_LIFECYCLE_ACTION_REQUIRED` | 400 | Archive/restore action not specified |
| `STAFF_ARCHIVED` | 409 | Staff account already archived |
| `ACTIVE_WORK_BLOCKS_ARCHIVE` | 409 | Cannot archive staff with active work blocks |
| `INVENTORY_ARCHIVED` | 409 | Inventory item already archived |
| `TOOL_ARCHIVED` | 409 | Tool already archived |
| `ACTIVE_CUSTODY_BLOCKS_ARCHIVE` | 409 | Cannot archive tool with active custody |
| `STOCK_NOT_RECORDED` | 400 | Stock count not entered |
| `STOCK_RESERVATION_FAILED` | 400 | Insufficient stock for reservation |

### Other Domain Codes

| Code | HTTP | Description |
|------|------|-------------|
| `INVALID_LIFECYCLE_REASON` | 400 | Data archival reason missing/invalid |
| `INVALID_ARCHIVE_REASON` | 400 | Staff archival reason missing/invalid |
| `INVALID_SERVICE_PAYLOAD` | 400 | Service catalog payload invalid |
| `WARRANTY_EVIDENCE_INVALID` | 400 | Warranty claim evidence missing/invalid |
| `WARRANTY_NOT_ACTIVE` | 409 | Warranty period has expired |
| `PROJECT_RECOVERY_REQUIRED` | 400 | Project needs recovery action |
| `PROJECT_WORK_SUBMISSION_REQUIRED` | 400 | Work submission required before phase advance |
| `POS_MERCHANDISE_ONLY` | 400 | POS only accepts merchandise items |
| `ATTENDANCE_EXCEPTION_OVERRIDE_REQUIRED` | 400 | Attendance exception needs override |
| `ATTENDANCE_EXCEPTION_REASON_REQUIRED` | 400 | Exception reason not provided |
| `PART_NOT_IN_INVENTORY` | 400 | Part not found in inventory system |
| `PART_OUT_OF_STOCK` | 400 | Part has zero available stock |
| `PARTS_NOT_READY` | 400 | Parts not yet prepared for assignment |
| `TECH_NOT_FOUND` | 404 | Technician record not found |
| `BOOKING_NOT_FOUND` | 404 | Booking record not found |
| `REASON_REQUIRED` | 400 | Generic reason field missing |
| `NOTE_REQUIRED` | 400 | Generic note field missing |
| `REFUND_DECISION_REQUIRED` | 400 | Refund action not specified |

---

## 4. Rate Limiting

| Limiter | Window | Max Requests | Response |
|---------|--------|-------------|----------|
| **Global API** | 1 minute | 100 per IP | `{ error: "Too many requests, please try again later" }` |
| **Auth endpoints** | 15 minutes | 10 per IP | `{ error: "Too many attempts, please try again later" }` |
| **Chat API** | 1 minute | 20 per IP | `{ error: "Too many messages, please slow down" }` |
| **Checkout** | 5 minutes | 5 per IP | `{ code: "ORDER_CHECKOUT_RATE_LIMITED" }` |
| **Attendance** | 1 minute | 1 per user | `{ code: "ATTENDANCE_RATE_LIMITED" }` |
| **Progressive login** | Escalating | 5 attempts/cycle | See §2 Progress Rate Limiter Response |

### Progressive Login Lockout Cycles

| Cycle | Lockout Duration |
|-------|-----------------|
| 1 | 3 minutes |
| 2 | 5 minutes |
| 3 | 10 minutes |
| 4+ | 30 minutes |

Lockout records expire after 24 hours (`server/middleware/loginRateLimiter.js:21`).

---

## 5. Security Errors

| Middleware | HTTP | Error | File |
|-----------|------|-------|------|
| `helmet` | — | Sets security headers (CSP, X-Frame-Options, etc.) | `server/index.js` |
| `express-mongo-sanitize` | — | Strips `$` and `.` from req.body/query/params/headers | `server/index.js` |
| `requireTrustedOrigin` | 403 | Origin header not in trusted list | `server/middleware/apiSecurity.js:31` |
| `authenticate` | 401/403 | Missing token, expired session, insufficient permissions | `server/middleware/authenticate.js` |
| `pageAuth` | 401/403 | Page access denied | `server/middleware/pageAuth.js` |
| `requirePermission` | 403 | RBAC permission check failed | `server/middleware/requirePermission.js:309` |
| `accountState` | 403 | Account blocked or email not verified | `server/middleware/accountState.js` |
| `maintenanceMode` | 503 | Site in maintenance mode | `server/middleware/maintenanceMode.js:14` |

---

## 6. Timestamp Formats

### Winston Logger (`server/utils/logger.js`)

**Format:** `YYYY-MM-DD HH:mm:ss`

```
2026-09-19 14:30:45 [mailer] info: Email sent successfully user_id=abc123
```

- Level: `error | warn | info | http | debug`
- Production level: `info`; Development: `debug`
- Log files: `logs/error.log` (errors only), `logs/combined.log` (all levels)

**Example error log entries:**

```
2026-09-19 08:15:23 [server] error: [ERROR] TypeError: Cannot read property 'email' of undefined
    at getProfile (C:/server/controllers/authController.js:142:25)
    at Layer.handle [as handle_request] (C:/node_modules/express/lib/router/layer.js:95:5)

2026-09-19 09:02:11 [mailer] warn: Email delivery failed user_id=usr_64f1a2b3 attempt=2

2026-09-19 10:30:45 [server] error: MongoDB connection timeout after 30000ms host=cluster0.abc.mongodb.net

2026-09-19 11:45:00 [scheduler] info: [delay-monitor] Checked 12 active bookings, 0 delays detected

2026-09-19 14:22:33 [server] warn: [reschedule-monitor] Booking bk_8x7y2z missed acceptance deadline, auto-reassigning

2026-09-19 16:00:01 [scheduler] error: [watchdog] Scheduler heartbeat missed for 60s, restarting overdue check

2026-09-19 17:30:15 [server] error: reCAPTCHA verification failed remote_ip=192.168.1.105 error=timeout-or-duplicate
```

### HTTP Request Logging (`server/index.js:164-178`)

**Format:** `METHOD /path status_code response_time`

```
2026-09-19 08:15:01 POST /api/auth/login 200 234.5ms
2026-09-19 08:15:03 GET /api/bookings 200 45.2ms
2026-09-19 08:16:10 POST /api/bookings 400 12.1ms
2026-09-19 08:17:45 GET /api/products 200 89.3ms
2026-09-19 09:00:02 POST /api/admin/inventory 403 8.4ms
2026-09-19 09:05:30 PUT /api/technician/attendance 429 3.1ms
2026-09-19 10:22:15 GET /api/orders/ord_9k8j2m 404 15.7ms
2026-09-19 11:30:00 POST /api/payments/process 500 5023.4ms
```

**How to read:** `METHOD` is HTTP verb, `/path` is the endpoint, `status_code` is the HTTP response, `response_time` shows server processing time. Slow responses (>1000ms) or 5xx errors indicate issues.

### Audit Trail (`server/utils/audit.js`)

Audit entries stored in MongoDB `ActivityLog` collection:

```json
{
  "actor": { "userId": "usr_64f1a2b3", "name": "John Doe", "role": "admin" },
  "action": "booking.created",
  "category": "booking",
  "riskLevel": "info",
  "outcome": "success",
  "details": { "serviceId": "svc_abc", "customerId": "cust_xyz" },
  "requestContext": {
    "ip": "192.168.1.1",
    "userAgent": "Mozilla/5.0...",
    "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "method": "POST",
    "path": "/api/bookings"
  },
  "createdAt": "2026-09-19T06:30:45.123Z"
}
```

- Dates serialized via `toISOString()` (ISO 8601 / UTC)
- Indexed by `category + createdAt`, `riskLevel + createdAt`

**Example audit entries with timestamps:**

```json
// Successful booking creation
{ "createdAt": "2026-09-19T01:15:23.456Z", "action": "booking.created", "category": "booking", "riskLevel": "info", "outcome": "success" }

// Failed login attempt
{ "createdAt": "2026-09-19T01:22:10.789Z", "action": "auth.login_failed", "category": "auth", "riskLevel": "medium", "outcome": "failure" }

// Payment processed
{ "createdAt": "2026-09-19T02:05:33.012Z", "action": "payment.processed", "category": "payment", "riskLevel": "low", "outcome": "success" }

// Staff archived
{ "createdAt": "2026-09-19T03:40:12.345Z", "action": "staff.archived", "category": "auth", "riskLevel": "high", "outcome": "success" }

// Inventory stock adjustment
{ "createdAt": "2026-09-19T04:55:01.678Z", "action": "inventory.adjusted", "category": "inventory", "riskLevel": "medium", "outcome": "success" }

// Unauthorized access attempt
{ "createdAt": "2026-09-19T05:10:45.901Z", "action": "auth.unauthorized_access", "category": "auth", "riskLevel": "critical", "outcome": "blocked" }
```

### MongoDB `timestamps: true`

34 models auto-generate `createdAt` and `updatedAt` as `Date` objects:

```json
{
  "createdAt": "2026-09-19T06:30:45.123Z",
  "updatedAt": "2026-09-19T08:15:22.456Z"
}
```

**Models with auto timestamps:**

| Model | File |
|-------|------|
| `ActivityLog` | `server/models/ActivityLog.js:46` |
| `AirconCart` | `server/models/AirconCart.js:34` |
| `Assignment` | `server/models/Assignment.js:161` |
| `Brand` | `server/models/Brand.js:20` |
| `Category` | `server/models/Category.js:20` |
| `CustomerAsset` | `server/models/CustomerAsset.js:49` |
| `EmployeeCompensation` | `server/models/EmployeeCompensation.js:47` |
| `EquipmentUsageLog` | `server/models/EquipmentUsageLog.js:25` |
| `Expense` | `server/models/Expense.js:101` |
| `HVACProduct` | `server/models/HVACProduct.js:337` |
| `Inventory` | `server/models/Inventory.js:262` |
| `MaintenanceSchedule` | `server/models/MaintenanceSchedule.js:109` |
| `Notification` | `server/models/Notification.js:159` |
| `Order` | `server/models/Order.js:334` |
| `PartsRequest` | `server/models/PartsRequest.js:129` |
| `Payroll` | `server/models/Payroll.js:120` |
| `ProjectIssue` | `server/models/ProjectIssue.js:73` |
| `ProjectResourcePurchase` | `server/models/ProjectResourcePurchase.js:18` |
| `ProjectWorkSubmission` | `server/models/ProjectWorkSubmission.js:48` |
| `Rating` | `server/models/Rating.js:46` |
| `Role` | `server/models/Role.js:30` |
| `SecretaryAttendance` | `server/models/SecretaryAttendance.js:42` |
| `ServiceCategory` | `server/models/ServiceCategory.js:31` |
| `ServiceReport` | `server/models/ServiceReport.js:117` |
| `ServiceToolUsage` | `server/models/ServiceToolUsage.js:133` |
| `SiteSetting` | `server/models/SiteSetting.js:12` |
| `StockAdjustment` | `server/models/StockAdjustment.js:88` |
| `StockReservation` | `server/models/StockReservation.js:79` |
| `TechnicianAttendance` | `server/models/TechnicianAttendance.js:134` |
| `TechnicianSchedule` | `server/models/TechnicianSchedule.js:39` |
| `Tool` | `server/models/Tool.js:185` |
| `ToolAssignment` | `server/models/ToolAssignment.js:72` |
| `WalkInSale` | `server/models/WalkInSale.js:115` |
| `WarrantyClaim` | `server/models/WarrantyClaim.js:89` |

### Manual Timestamp Fields

Some models define timestamps manually (no auto `updatedAt`):

| Model | Fields | File |
|-------|--------|------|
| `AuthSession` | `createdAt` | `server/models/AuthSession.js:8` |
| `BookingService` | `createdAt`, `updatedAt`, `cancelledAt`, `statusHistory[].timestamp`, `rescheduleRequest.expiresAt`, `quotation.expiresAt` | `server/models/BookingService.js` |
| `CoreService` | `createdAt`, `updatedAt` | `server/models/CoreService.js:83` |
| `DailyAssignment` | `createdAt`, `updatedAt` | `server/models/DailyAssignment.js:37` |
| `DailyKit` | `createdAt`, `updatedAt` | `server/models/DailyKit.js:170` |
| `EquipmentAssignment` | `createdAt`, `updatedAt` | `server/models/EquipmentAssignment.js:71` |
| `LeaveRequest` | `createdAt`, `updatedAt` | `server/models/LeaveRequest.js:27` |
| `LoginHistory` | `createdAt` | `server/models/LoginHistory.js:15` |
| `NonWorkingDay` | `createdAt` | `server/models/NonWorkingDay.js:14` |
| `Project` | `createdAt`, `updatedAt` | `server/models/Project.js:543` |
| `ProjectMaterial` | `cancelledAt` | `server/models/ProjectMaterial.js:57` |
| `RepairService` | `createdAt`, `updatedAt` | `server/models/RepairService.js:82` |
| `Service` | `createdAt`, `updatedAt` | `server/models/Service.js` |
| `TrustedDevice` | `createdAt`, `lastUsedAt`, `expiresAt`, `revokedAt`, `passwordChangedAt` | `server/models/TrustedDevice.js:16` |
| `EmailDeliveryLog` | `createdAt` | `server/models/EmailDeliveryLog.js:13` |

### Client-Side Display Formats

| Context | Format | Code Location |
|---------|--------|---------------|
| General date display | `.toLocaleString("en-PH")` | Various EJS templates |
| Chat timestamps | `.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })` | Chat components |
| MongoDB aggregation | `$dateToString: { format: "%Y-%m-%d" }` | `server/controllers/adminController.js:680` |
| Policy date validation | `/^(\d{4})-(\d{2})-(\d{2})$/` (YYYY-MM-DD) | `auditTrailPolicy.js:36`, `orderCheckoutPolicy.js:32` |

### Error Log Examples with Timestamps

Real-world examples showing how errors appear across the system with timestamps:

**Winston console output (development):**
```
2026-09-19 08:15:23 [server] error: [ERROR] TypeError: Cannot read property 'email' of undefined
    at getProfile (server/controllers/authController.js:142:25)

2026-09-19 08:15:24 [server] error: [ERROR] ValidationError: "slot" is required
    at createBooking (server/routes/appointmentRoutes.js:205:15)

2026-09-19 08:16:01 [server] warn: [delay-monitor] Booking bk_8x7y2z missed acceptance deadline

2026-09-19 09:02:11 [mailer] error: SMTP connection failed host=smtp.gmail.com port=587

2026-09-19 09:30:45 [scheduler] info: [reschedule-monitor] Checked 15 bookings, 2 rescheduled

2026-09-19 10:15:00 [server] error: E11000 duplicate key error collection: racs.users index: email_1 dup key: { email: "john@gmail.com" }

2026-09-19 11:45:33 [server] warn: [verify-reminder] 3 bookings pending verification for 2+ hours

2026-09-19 14:22:10 [server] error: [ERROR] JsonWebTokenError: invalid signature
    at verify (server/middleware/authenticate.js:45:15)

2026-09-19 15:00:02 [scheduler] info: [midnight-reset] Daily attendance reset completed, 8 technicians marked absent

2026-09-19 16:30:45 [server] error: reCAPTCHA verification failed remote_ip=203.177.xx.xx error=timeout-or-duplicate

2026-09-19 17:00:00 [server] error: Socket.IO connection error: CORS origin mismatch origin=http://localhost:3000

2026-09-19 18:15:30 [scheduler] error: [watchdog] Scheduler heartbeat missed for 120s, restarting overdue check
```

**Winston file output (`logs/error.log`):**
```
2026-09-19 08:15:23 [server] error: [ERROR] TypeError: Cannot read property 'email' of undefined key=value
2026-09-19 09:02:11 [mailer] error: SMTP connection failed host=smtp.gmail.com key=value
2026-09-19 10:15:00 [server] error: E11000 duplicate key error collection=racs.users index=email_1 key=value
2026-09-19 14:22:10 [server] error: JsonWebTokenError: invalid signature key=value
2026-09-19 16:30:45 [server] error: reCAPTCHA verification failed remote_ip=203.177.xx.xx key=value
2026-09-19 17:00:00 [server] error: Socket.IO connection error: CORS origin mismatch key=value
```

**HTTP request log with error responses:**
```
2026-09-19 08:16:01 POST /api/bookings 400 12.1ms     <-- Validation error (slot required)
2026-09-19 08:16:05 GET /api/users/usr_999 404 8.3ms   <-- User not found
2026-09-19 09:00:02 POST /api/admin/inventory 403 8.4ms <-- Permission denied
2026-09-19 09:05:30 PUT /api/technician/attendance 429 3.1ms <-- Rate limited
2026-09-19 11:30:00 POST /api/payments/process 500 5023.4ms <-- Server error (slow)
2026-09-19 13:45:00 POST /api/auth/login 429 5.2ms     <-- Login lockout active
```

**Audit trail entries with timestamps (MongoDB):**
```json
{ "createdAt": "2026-09-19T01:15:23.456Z", "action": "auth.login_failed", "category": "auth", "riskLevel": "medium", "outcome": "failure", "details": { "email": "john@gmail.com", "reason": "invalid_password" } }
{ "createdAt": "2026-09-19T01:15:28.789Z", "action": "auth.login_failed", "category": "auth", "riskLevel": "high", "outcome": "failure", "details": { "email": "john@gmail.com", "reason": "invalid_password", "attempt": 2 } }
{ "createdAt": "2026-09-19T01:15:33.012Z", "action": "auth.login_failed", "category": "auth", "riskLevel": "critical", "outcome": "blocked", "details": { "email": "john@gmail.com", "reason": "account_locked", "lockout_until": "2026-09-19T01:20:33.012Z" } }
{ "createdAt": "2026-09-19T02:30:15.345Z", "action": "booking.created", "category": "booking", "riskLevel": "info", "outcome": "success" }
{ "createdAt": "2026-09-19T03:45:00.678Z", "action": "payment.failed", "category": "payment", "riskLevel": "high", "outcome": "failure", "details": { "reason": "insufficient_funds", "amount": 2500 } }
{ "createdAt": "2026-09-19T05:10:45.901Z", "action": "auth.unauthorized_access", "category": "auth", "riskLevel": "critical", "outcome": "blocked", "details": { "endpoint": "/api/admin/users", "requiredPermission": "admin:users:read" } }
```

**Common error patterns by timestamp (for debugging):**
| Time Window | Pattern | Likely Cause |
|-------------|---------|--------------|
| 00:00–06:00 | Multiple `SMTP connection failed` | Email provider maintenance window |
| 08:00–09:00 | Spike in `429` responses | Morning login rush, rate limit triggered |
| 12:00–13:00 | `500` responses with high response times | Peak load, server resource contention |
| 17:00–18:00 | `Socket.IO connection error` | End-of-day session cleanup, CORS issues |
| 00:00–06:00 | `[midnight-reset]` scheduler errors | Cron job failing, check DB connection |

---

## 7. TTL & Expiration Values

### Authentication & Sessions

| Item | TTL | File |
|------|-----|------|
| Session (default) | 30 minutes | `server/index.js:230` |
| Remember-me session | 30 days | `server/controllers/secureAuthController.js:332` |
| Registration OTP | 10 minutes | `server/controllers/authController.js:96` |
| OTP resend throttle | 60 seconds | `server/controllers/authController.js:97` |
| OTP max attempts | 5 | `server/controllers/authController.js:98` |
| Google OAuth state | 10 minutes | `server/controllers/googleAuthController.js:11` |
| Password reset token | 15 minutes | `server/models/User.js:129` |
| Account invitation | 24 hours | `server/models/User.js:144` |
| Login rate limiter record | 24 hours | `server/middleware/loginRateLimiter.js:21` |

### Attendance Security

| Item | Default | Range | File |
|------|---------|-------|------|
| QR code TTL | 45 seconds | 20–120s | `server/utils/attendanceSecurity.js:21` |
| Location max age | 120 seconds | 30–300s | `server/utils/attendanceSecurity.js:24` |
| Geofence radius | 250 meters | 50–2000m | `server/utils/attendanceSecurity.js:22` |
| Max GPS accuracy | 100 meters | 20–500m | `server/utils/attendanceSecurity.js:23` |

### Caching

| Cache | TTL | File |
|-------|-----|------|
| Company data | 60 seconds | `server/index.js:341` |
| System config | 30 seconds | `server/utils/systemConfiguration.js:6` |
| Geocode results | 2 minutes | `server/routes/serviceRoutes.js:280` |
| PSGC data | 1 hour | `server/routes/psgcRoutes.js:22` |
| Chat knowledge base | 60 seconds | `server/routes/chatRoutes.js:115` |
| Chat session | 30 minutes | `server/routes/chatRoutes.js:1034` |
| Assignments (client) | 30 seconds | `server/views/pages/technician/assignments.ejs:8900` |

### Data Retention

| Item | TTL | File |
|------|-----|------|
| Email delivery logs | 90 days | `server/models/EmailDeliveryLog.js:16` |
| Maintenance schedule expiry | 7 days | `server/routes/appointmentManagement.js:2067` |
| Project notify throttle | 60 seconds | `server/routes/projectRoutes.js:578` |

### Progression Lockout Escalation

| Cycle | Lockout Duration |
|-------|-----------------|
| 1 | 3 minutes |
| 2 | 5 minutes |
| 3 | 10 minutes |
| 4+ | 30 minutes |

---

*Generated from codebase analysis. Last updated: September 2026.*
