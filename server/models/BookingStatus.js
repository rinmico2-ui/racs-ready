/**
 * Enterprise Booking Status Constants
 * Single source of truth for the entire booking lifecycle
 *
 * Flow: Customer Creates → Pending Review → Payment Verified → Assignment Queue →
 *       Assigned → Technician Accepts → Confirmed → On The Way → In Progress → Completed
 */

const BookingStatus = {
  // Stage 1: Customer creates booking
  PENDING: 'pending',

  // Stage 2: Admin reviews booking
  REJECTED: 'rejected',
  PAYMENT_VERIFIED: 'payment_verified',

  // Stage 3: Assignment queue
  AWAITING_ASSIGNMENT: 'awaiting_assignment',

  // Stage 4: Technician assigned
  ASSIGNED: 'assigned',
  PENDING_REASSIGNMENT: 'pending_reassignment',

  // Stage 5: Technician responds
  CONFIRMED: 'confirmed',

  // Stage 6: Service execution
  SCHEDULED: 'scheduled',
  ON_THE_WAY: 'on-the-way',
  ARRIVED: 'arrived',
  WAITING_FOR_CUSTOMER: 'waiting-for-customer',
  NO_SHOW_REPORTED: 'no-show-reported',
  IN_PROGRESS: 'in-progress',

  // Stage 7: Completion
  COMPLETED: 'completed',

  // Terminal states
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  RESCHEDULED: 're-scheduled',
  NO_SHOW: 'no-show',
  RESCHEDULE_REQUIRED: 'reschedule-required',

  // ── Repair Work Order Lifecycle ──────────────────────────────────────
  // Step 1: Customer submits a repair request (inspection-first)
  REPAIR_REQUESTED: 'repair_requested',

  // Step 2: Admin reviews and schedules inspection
  PENDING_INSPECTION: 'pending_inspection',
  INSPECTION_SCHEDULED: 'inspection_scheduled',

  // Step 3: Technician performs on-site inspection
  INSPECTION_IN_PROGRESS: 'inspection_in_progress',
  INSPECTION_COMPLETED: 'inspection_completed',

  // Step 4: Quotation sent, awaiting customer decision
  AWAITING_APPROVAL: 'awaiting_approval',

  // Step 5: Customer decides
  REPAIR_APPROVED: 'repair_approved',
  REPAIR_DECLINED: 'repair_declined',

  // Step 6: Parts procurement (if needed)
  WAITING_PARTS: 'waiting_parts',
  PARTS_RESERVED: 'parts_reserved',

  // Step 7: Repair execution
  READY_FOR_REPAIR: 'ready_for_repair',
  REPAIR_SCHEDULED: 'repair_scheduled',
  REPAIR_IN_PROGRESS: 'repair_in_progress',

  // Step 8: Completion & lifecycle
  REPAIR_COMPLETED: 'repair_completed',
  UNDER_WARRANTY: 'under_warranty',
  WARRANTY_CLAIM: 'warranty_claim',

  // Terminal
  CLOSED: 'closed',

  // ── Large Project Lifecycle ─────────────────────────────────────────
  PENDING_PROJECT_SCHEDULING: 'pending_project_scheduling',
};

const PaymentStatus = {
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  PARTIAL: 'partial',
};

const AssignmentStatus = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  EN_ROUTE: 'en_route',
  ON_SITE: 'on_site',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

/**
 * Status transition map: which statuses can transition to which
 * Key = current status, Value = array of valid next statuses
 */
const StatusTransitions = {
  [BookingStatus.PENDING]: [
    BookingStatus.PAYMENT_VERIFIED,
    BookingStatus.REJECTED,
    BookingStatus.CANCELLED,
    BookingStatus.EXPIRED,
  ],
  [BookingStatus.PAYMENT_VERIFIED]: [
    BookingStatus.AWAITING_ASSIGNMENT,
    BookingStatus.CANCELLED,
    BookingStatus.EXPIRED,
  ],
  [BookingStatus.AWAITING_ASSIGNMENT]: [
    BookingStatus.ASSIGNED,
    BookingStatus.PENDING_REASSIGNMENT,
    BookingStatus.INSPECTION_SCHEDULED,
    BookingStatus.CANCELLED,
    BookingStatus.EXPIRED,
  ],
  [BookingStatus.ASSIGNED]: [
    BookingStatus.CONFIRMED,
    BookingStatus.PENDING_REASSIGNMENT,
    BookingStatus.CANCELLED,
    BookingStatus.EXPIRED,
  ],
  [BookingStatus.PENDING_REASSIGNMENT]: [
    BookingStatus.ASSIGNED,
    BookingStatus.CANCELLED,
    BookingStatus.EXPIRED,
  ],
  [BookingStatus.CONFIRMED]: [
    BookingStatus.SCHEDULED,
    BookingStatus.PENDING_REASSIGNMENT,
    BookingStatus.ON_THE_WAY,
    BookingStatus.CANCELLED,
  ],
  [BookingStatus.SCHEDULED]: [
    BookingStatus.PENDING_REASSIGNMENT,
    BookingStatus.ON_THE_WAY,
    BookingStatus.CANCELLED,
  ],
  [BookingStatus.ON_THE_WAY]: [
    BookingStatus.ARRIVED,
  ],
  [BookingStatus.ARRIVED]: [
    BookingStatus.IN_PROGRESS,
    BookingStatus.WAITING_FOR_CUSTOMER,
  ],
  [BookingStatus.WAITING_FOR_CUSTOMER]: [
    BookingStatus.NO_SHOW_REPORTED,
    BookingStatus.IN_PROGRESS,
  ],
  [BookingStatus.NO_SHOW_REPORTED]: [
    BookingStatus.NO_SHOW,
    BookingStatus.RESCHEDULE_REQUIRED,
    BookingStatus.AWAITING_ASSIGNMENT,
  ],
  [BookingStatus.NO_SHOW]: [
    BookingStatus.RESCHEDULE_REQUIRED,
    BookingStatus.AWAITING_ASSIGNMENT,
    BookingStatus.CANCELLED,
  ],
  [BookingStatus.RESCHEDULE_REQUIRED]: [
    BookingStatus.AWAITING_ASSIGNMENT,
    BookingStatus.CANCELLED,
  ],
  [BookingStatus.IN_PROGRESS]: [
    BookingStatus.COMPLETED,
  ],
  [BookingStatus.COMPLETED]: [],
  [BookingStatus.CANCELLED]: [],
  [BookingStatus.RESCHEDULED]: [
    BookingStatus.CONFIRMED,
    BookingStatus.SCHEDULED,
    BookingStatus.ON_THE_WAY,
    BookingStatus.CANCELLED,
  ],

  // ── Enterprise Repair Work Order Transitions ──────────────────────────
  // Inspection-first workflow: request → confirm → assignment queue → assign tech → inspection
  [BookingStatus.REPAIR_REQUESTED]: [
    BookingStatus.AWAITING_ASSIGNMENT,
    BookingStatus.CANCELLED,
  ],
  [BookingStatus.PENDING_INSPECTION]: [
    BookingStatus.INSPECTION_SCHEDULED,
    BookingStatus.CANCELLED,
    BookingStatus.CLOSED,
  ],
  [BookingStatus.INSPECTION_SCHEDULED]: [
    BookingStatus.INSPECTION_IN_PROGRESS,
    BookingStatus.CANCELLED,
  ],
  [BookingStatus.INSPECTION_IN_PROGRESS]: [
    BookingStatus.INSPECTION_COMPLETED,
    BookingStatus.CANCELLED,
  ],
  // Diagnosis completed → generate quotation → await customer decision
  [BookingStatus.INSPECTION_COMPLETED]: [
    BookingStatus.AWAITING_APPROVAL,
    BookingStatus.CANCELLED,
  ],
  [BookingStatus.AWAITING_APPROVAL]: [
    BookingStatus.REPAIR_APPROVED,
    BookingStatus.REPAIR_DECLINED,
    BookingStatus.CANCELLED,
  ],
  // Customer approved → evaluate immediate vs scheduled repair
  [BookingStatus.REPAIR_APPROVED]: [
    BookingStatus.WAITING_PARTS,
    BookingStatus.READY_FOR_REPAIR,
    BookingStatus.REPAIR_IN_PROGRESS,  // immediate repair after inspection
    BookingStatus.REPAIR_SCHEDULED,
    BookingStatus.CANCELLED,
  ],
  [BookingStatus.REPAIR_DECLINED]: [
    BookingStatus.CLOSED,
  ],
  // Parts procurement flow
  [BookingStatus.WAITING_PARTS]: [
    BookingStatus.PARTS_RESERVED,
    BookingStatus.READY_FOR_REPAIR,
    BookingStatus.CANCELLED,
  ],
  [BookingStatus.PARTS_RESERVED]: [
    BookingStatus.READY_FOR_REPAIR,
    BookingStatus.CANCELLED,
  ],
  // Ready for repair → schedule or start immediately
  [BookingStatus.READY_FOR_REPAIR]: [
    BookingStatus.REPAIR_SCHEDULED,
    BookingStatus.REPAIR_IN_PROGRESS,
    BookingStatus.CANCELLED,
  ],
  [BookingStatus.REPAIR_SCHEDULED]: [
    BookingStatus.REPAIR_IN_PROGRESS,
    BookingStatus.CANCELLED,
  ],
  // Repair execution
  [BookingStatus.REPAIR_IN_PROGRESS]: [
    BookingStatus.REPAIR_COMPLETED,
    BookingStatus.CANCELLED,
  ],
  // Completion & lifecycle
  [BookingStatus.REPAIR_COMPLETED]: [
    BookingStatus.UNDER_WARRANTY,
    BookingStatus.CLOSED,
  ],
  [BookingStatus.UNDER_WARRANTY]: [
    BookingStatus.WARRANTY_CLAIM,
    BookingStatus.CLOSED,
  ],
  [BookingStatus.WARRANTY_CLAIM]: [
    BookingStatus.INSPECTION_SCHEDULED,  // New inspection for warranty claim
    BookingStatus.REPAIR_IN_PROGRESS,    // Direct repair if approved
    BookingStatus.CLOSED,
  ],
  [BookingStatus.CLOSED]: [],

  // ── Project Booking Lifecycle ────────────────────────────────────────
  [BookingStatus.PENDING_PROJECT_SCHEDULING]: [
    BookingStatus.CANCELLED,
    BookingStatus.CLOSED,
  ],
};

/**
 * Flow stages for admin UI grouping
 */
const FlowStages = {
  PENDING_REVIEW: {
    label: 'Pending Review',
    statuses: [BookingStatus.PENDING, BookingStatus.PAYMENT_VERIFIED],
    color: '#f59e0b',
    icon: 'bi-clock-history',
  },
  ASSIGNMENT_QUEUE: {
    label: 'Assignment Queue',
    statuses: [BookingStatus.AWAITING_ASSIGNMENT, BookingStatus.ASSIGNED, BookingStatus.PENDING_REASSIGNMENT, BookingStatus.RESCHEDULED],
    color: '#8b5cf6',
    icon: 'bi-people',
  },
  ACTIVE_JOBS: {
    label: 'Active Jobs',
    statuses: [
      BookingStatus.CONFIRMED,
      BookingStatus.SCHEDULED,
      BookingStatus.ON_THE_WAY,
      BookingStatus.ARRIVED,
      BookingStatus.IN_PROGRESS,
    ],
    color: '#22c55e',
    icon: 'bi-tools',
  },
  REPAIR_JOBS: {
    label: 'Repair Jobs',
    statuses: [
      BookingStatus.REPAIR_REQUESTED,
      BookingStatus.PENDING_INSPECTION,
      BookingStatus.INSPECTION_SCHEDULED,
      BookingStatus.INSPECTION_IN_PROGRESS,
      BookingStatus.INSPECTION_COMPLETED,
      BookingStatus.AWAITING_APPROVAL,
      BookingStatus.REPAIR_APPROVED,
      BookingStatus.REPAIR_DECLINED,
      BookingStatus.WAITING_PARTS,
      BookingStatus.PARTS_RESERVED,
      BookingStatus.READY_FOR_REPAIR,
      BookingStatus.REPAIR_SCHEDULED,
      BookingStatus.REPAIR_IN_PROGRESS,
    ],
    color: '#f97316',
    icon: 'bi-wrench',
  },
  REPAIR_COMPLETED: {
    label: 'Completed Repairs',
    statuses: [
      BookingStatus.REPAIR_COMPLETED,
      BookingStatus.UNDER_WARRANTY,
      BookingStatus.WARRANTY_CLAIM,
    ],
    color: '#10b981',
    icon: 'bi-check-circle',
  },
  COMPLETED: {
    label: 'Completed',
    statuses: [BookingStatus.COMPLETED],
    color: '#10b981',
    icon: 'bi-check-circle',
  },
  REJECTED: {
    label: 'Rejected',
    statuses: [BookingStatus.REJECTED],
    color: '#ef4444',
    icon: 'bi-x-circle',
  },
  CANCELLED: {
    label: 'Cancelled',
    statuses: [BookingStatus.CANCELLED, BookingStatus.CLOSED],
    color: '#6b7280',
    icon: 'bi-slash-circle',
  },
  EXPIRED: {
    label: 'Expired',
    statuses: [BookingStatus.EXPIRED],
    color: '#d97706',
    icon: 'bi-clock-history',
  },
  PROJECTS: {
    label: 'Projects',
    statuses: [BookingStatus.PENDING_PROJECT_SCHEDULING],
    color: '#6366f1',
    icon: 'bi-building',
  },
};

/**
 * Assignment status → Booking status mapping
 */
const AssignmentToBookingStatusMap = {
  [AssignmentStatus.ACCEPTED]: BookingStatus.CONFIRMED,
  [AssignmentStatus.EN_ROUTE]: BookingStatus.ON_THE_WAY,
  [AssignmentStatus.ON_SITE]: BookingStatus.ARRIVED,
  [AssignmentStatus.IN_PROGRESS]: BookingStatus.IN_PROGRESS,
  [AssignmentStatus.COMPLETED]: BookingStatus.COMPLETED,
  [AssignmentStatus.CANCELLED]: BookingStatus.PENDING_REASSIGNMENT,
  [AssignmentStatus.DECLINED]: BookingStatus.PENDING_REASSIGNMENT,
};

module.exports = {
  BookingStatus,
  PaymentStatus,
  AssignmentStatus,
  StatusTransitions,
  FlowStages,
  AssignmentToBookingStatusMap,
};
