/* Domain grouping + one-line purpose per entity.
 * Hand-authored intent only; types/refs come from the live schemas. */

const DOMAINS = [
  { id: 'D1', name: 'Identity & Access', blurb: 'Accounts, staff extensions, sessions and the login security trail.' },
  { id: 'D2', name: 'Service & Product Catalog', blurb: 'Priced services, taxonomies and product master data.' },
  { id: 'D3', name: 'Booking & Dispatch', blurb: 'The core transaction: quote -> schedule -> dispatch -> completion.' },
  { id: 'D4', name: 'Stock & Field Resources', blurb: 'Three product catalogs plus tool custody and consumption.' },
  { id: 'D5', name: 'Project Delivery', blurb: 'Multi-unit (8+) work split into work orders and daily assignments.' },
  { id: 'D6', name: 'Sales & Carts', blurb: 'Online storefront, POS till and aircon merchandising.' },
  { id: 'D7', name: 'Finance & Compensation', blurb: 'Payments, payroll and technician field expenses.' },
  { id: 'D8', name: 'Aftercare & Feedback', blurb: 'Assets, maintenance cycles, warranty, returns, ratings.' },
  { id: 'D9', name: 'Attendance & Leave', blurb: 'Timekeeping plus the inputs that drive technician availability.' },
  { id: 'D10', name: 'Platform Services', blurb: 'Settings, audit, notifications, email queue, distributed locks.' },
];

const DOMAIN_OF = {
  User: 'D1', Role: 'D1', AuthSession: 'D1', TrustedDevice: 'D1', LoginHistory: 'D1',
  FailedLoginAttempt: 'D1', Technician: 'D1', Secretary: 'D1',
  CoreService: 'D2', RepairService: 'D2', Service: 'D2', ServiceCategory: 'D2',
  HVACProduct: 'D2', Brand: 'D2', Category: 'D2',
  BookingService: 'D3', Assignment: 'D3', TechnicianSchedule: 'D3', NonWorkingDay: 'D3',
  UnitAssistanceRequest: 'D3', RelocationRequest: 'D3', ServiceReport: 'D3',
  Inventory: 'D4', Tool: 'D4', ToolAssignment: 'D4', StockReservation: 'D4', StockAdjustment: 'D4',
  ServiceToolUsage: 'D4', EquipmentAssignment: 'D4', EquipmentUsageLog: 'D4', DailyKit: 'D4', PartsRequest: 'D4',
  Project: 'D5', WorkOrder: 'D5', DailyAssignment: 'D5', ProjectMaterial: 'D5', ProjectIssue: 'D5',
  ProjectResourcePurchase: 'D5', ProjectWorkSubmission: 'D5',
  AirconCart: 'D6', Order: 'D6', Purchase: 'D6', WalkInSale: 'D6',
  Payment: 'D7', Payroll: 'D7', Expense: 'D7', EmployeeCompensation: 'D7',
  CustomerAsset: 'D8', MaintenanceSchedule: 'D8', WarrantyClaim: 'D8', ProductReturn: 'D8',
  ProductRefund: 'D8', ProductReturnMovement: 'D8', Rating: 'D8',
  TechnicianAttendance: 'D9', SecretaryAttendance: 'D9', LeaveRequest: 'D9',
  SiteSetting: 'D10', ActivityLog: 'D10', Notification: 'D10', EmailOutbox: 'D10',
  EmailDeliveryLog: 'D10', OperationLock: 'D10',
};

const PURPOSE = {
  User: 'Account. `role` is a STRING joined to `Role.name`, not an ObjectId.',
  Role: 'Permission matrix. Joined by name; system rows cannot be deleted.',
  Technician: 'Field-staff extension of User. Holds rating, availability and live GPS.',
  Secretary: 'Dispatcher extension of User. Not unique-indexed (see risks).',
  AuthSession: 'Session registry for token revocation. No back-pointer from User.',
  TrustedDevice: '"Remember me" device token. tokenHash stored; TTL on expiresAt.',
  LoginHistory: 'Immutable audit row per successful login, geo/device enriched.',
  FailedLoginAttempt: 'Brute-force throttle counter, one doc per email identity.',

  CoreService: 'Priced routine/maintenance service. `category` is free text.',
  RepairService: 'Priced diagnostic-led repair. No category, no lifecycle fields.',
  Service: 'Legacy 23-line stub, referenced only by NonWorkingDay.',
  ServiceCategory: 'Service taxonomy + unit types + inspection fees + warranty policy.',
  Brand: 'Product brand. Parent of Inventory and HVACProduct only.',
  Category: 'Product taxonomy. Parent of Inventory and HVACProduct only.',
  HVACProduct: 'Aircon catalog: one doc per model line with an embedded variants[] array.',
  Inventory: 'Flat SKU catalog: one doc per brand+modelLine+capacity. Legacy twin of HVACProduct.',

  BookingService: 'AGGREGATE ROOT of the service business. Embeds services[], units[], inspection, diagnosis, quotation, warranty.',
  Assignment: 'The operational job ticket. Own acceptance SLA + proof-of-work chain.',
  ServiceReport: 'Completion record, upserted per (bookingId, serviceItemId).',
  UnitAssistanceRequest: 'Pre-booking "I do not know my unit HP" quote. Converts into a booking.',
  RelocationRequest: 'Pre-booking custom relocation quote across properties. Converts into a booking.',
  TechnicianSchedule: 'Weekly working pattern + rest dates. UNIQUE per technician.',
  NonWorkingDay: 'Company- or service-scoped day off. Refs the LEGACY Service model.',

  Tool: 'Service tools / parts / consumables. The ONLY catalog with a reservation ledger.',
  ToolAssignment: 'Simple long-term tool custody (no date dimension).',
  EquipmentAssignment: 'Per-work-day checkout/return with damage and overdue escalation.',
  EquipmentUsageLog: 'Free-text daily usage log. No quantity, so it cannot drive stock.',
  DailyKit: 'Per-technician-per-day dispatch preparation sheet.',
  ServiceToolUsage: 'Material/parts CONSUMPTION ledger. Links booking/order/project/assignment.',
  StockReservation: 'Soft or hard hold of Tool quantity for a repair booking.',
  StockAdjustment: 'Append-only before/after ledger for Tool quantity. Tool ONLY.',
  PartsRequest: 'Procurement request when stock cannot cover a repair. Blocks booking in waiting_parts.',

  Project: 'Multi-unit engagement (8+ units) created FROM a booking. Root of delivery.',
  WorkOrder: 'A scoped unit of project work. Unique (projectId, workOrderNumber).',
  DailyAssignment: 'One technician, one work order, one day.',
  ProjectMaterial: 'Inventory reservation line for a project. Holds the Tool pointer via bare sourceId.',
  ProjectIssue: 'Technician-raised blocker during project execution.',
  ProjectResourcePurchase: 'Procurement record for a project resource shortage.',
  ProjectWorkSubmission: 'End-of-day proof of work + consumable declaration.',

  AirconCart: 'Online staging. Lines are PULLED on checkout; no orderId back-reference.',
  Order: 'Aircon sale, online AND POS. salesChannel + fulfilmentType are separate discriminators.',
  WalkInSale: 'POS MERCHANDISE sale only. NO Payment document is created for these.',
  Purchase: 'Dead legacy model. Refs the unregistered model `Product`.',

  Payment: 'Financial transaction. FOUR parallel nullable parent refs, no discriminator.',
  Payroll: 'Payslip. attendanceSummary is a frozen snapshot, not a join to attendance rows.',
  EmployeeCompensation: 'Rate card history. Partial unique (employee, effectiveFrom) while active.',
  Expense: 'Technician field expense. Optional booking/project/workOrder link. NOT linked to Payroll.',

  CustomerAsset: 'A physical unit the customer owns. Polymorphic origin (booking|order).',
  MaintenanceSchedule: 'Recurring maintenance cycle for an asset. Cyclic FK with CustomerAsset.',
  WarrantyClaim: 'Claim filed against a frozen warranty coverage snapshot.',
  ProductReturn: 'RMA against an Order or a WalkInSale. Optionally reaches into WorkOrder.',
  ProductRefund: 'Money out for a return. returnId is UNIQUE, so at most one refund per return.',
  ProductReturnMovement: 'Custody ledger for returned goods. Unique (returnId, type).',
  Rating: 'Feedback. targetType/targetId have NO refPath, so populate is impossible.',

  TechnicianAttendance: 'One row per technician per day. GPS + geofence + QR evidence.',
  SecretaryAttendance: 'One row per secretary per day. NO GPS evidence subdocument.',
  LeaveRequest: 'Approved leave blocks technician availability. No secretary equivalent.',

  SiteSetting: 'Untyped key/value runtime config. No owner, group or version.',
  ActivityLog: 'Audit trail. entityType + entityId (untyped) identify the acted-on entity.',
  Notification: 'In-app inbox. Dual-mode addressing: userId OR role broadcast.',
  EmailOutbox: 'Durable send queue. Payload AES-256-GCM encrypted; recipient stored as SHA-256.',
  EmailDeliveryLog: 'Provider delivery record. PLAINTEXT recipient. No outboxId back-link.',
  OperationLock: 'Distributed mutex. _id IS the lock name. TTL on expiresAt.',
};

module.exports = { DOMAINS, DOMAIN_OF, PURPOSE };
