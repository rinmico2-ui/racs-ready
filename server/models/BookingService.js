const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema({
  // keep a reference to the user and technician so we can still run joins/query
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  technicianId: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },

  // Installation orders keep a linked booking for calendar/customer history,
  // but the Order remains the operational and inventory source of truth.
  sourceOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null, index: true },

  // snapshots of the customer/technician info at the time of booking
  // this allows us to show the name/contact even if either account is later
  customer: {
    _id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    name: String,
    email: String,
    phone: String,
    address: String,
  },

  // Staff attestation and delivery state for account access linked during a
  // walk-in appointment. Authentication secrets are never stored here.
  customerAccountAccess: {
    consentedAt: { type: Date, default: null },
    capturedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    stateAtCheckout: {
      type: String,
      enum: ["active", "invited", "pending_verification"],
      default: "active",
    },
    invitationDelivery: {
      type: String,
      enum: ["not_sent", "accepted", "failed", "pending_registration"],
      default: "not_sent",
    },
    invitationSentAt: { type: Date, default: null },
  },

  technician: {
    _id: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
    name: String,
    phone: String,
    email: String,
    // additional fields can be added (eg. speciality) if needed
  },

  // reference to either a CoreService or RepairService document.
  // `serviceModel` is automatically derived from `serviceType` so that
  // mongoose can use `refPath` to populate the proper collection.
  serviceId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: "serviceModel",
  },

  serviceModel: {
    type: String,
    enum: ["CoreService", "RepairService"],
  },

  // Persist the booking classification used throughout scheduling, repair
  // workflows and reporting.  Several creation routes already send this
  // value; without a schema path Mongoose strict mode silently drops it.
  serviceType: {
    type: String,
    enum: ["core", "repair", "mixed"],
    default: "core",
    index: true,
  },

  // snapshot of the service chosen (for display even if service doc changes)
  service: {
    _id: { type: mongoose.Schema.Types.ObjectId, refPath: "serviceModel" },
    name: String,
    description: String,
    basePrice: Number,
    // additional fields can be added as required (icon, category, etc.)
  },
  servicePrice: { type: Number }, // snapshot of cost at booking time
  serviceDurationMinutes: { type: Number },

  // Aircon brand & appliance type captured from the customer at booking time
  brand: { type: String },
  applianceType: { type: String }, // 'split' | 'window' | 'cassette' | 'floor_standing'
  applianceTypeName: { type: String }, // Display label e.g. "Split Type"
  hp: { type: Number },             // HP rating for aircon services
  hpDescription: { type: String },  // e.g. "1.5 HP Split Type"

  // Multi-service booking support
  isMultiService: { type: Boolean, default: false },
  services: [{
    serviceId: { type: mongoose.Schema.Types.ObjectId },
    name: String,
    // `type` is a reserved schema-definition key in Mongoose. It must be
    // wrapped or Mongoose interprets the entire services array as [String].
    type: { type: String }, // 'core' or 'repair'
    quantity: { type: Number, min: 1, max: 40, default: 1 },
    unitPrice: Number,
    totalPrice: Number,
    hp: Number, // HP rating for aircon services
    hpDescription: String,
    airconType: String,
    airconTypeName: String,
    applianceType: String, // Customer-facing appliance type: 'split' | 'window' | 'cassette' | 'floor_standing'
    applianceTypeName: String, // Display label e.g. "Split Type"
    brand: String, // Aircon brand name (e.g. Carrier, Daikin)
    duration: Number,
    isAirconService: Boolean,
    repairIssue: String, // Individual repair issue description
    model: { type: String, trim: true },
    problemDescription: { type: String, trim: true },
    unitCategory: { type: String, trim: true },
    symptoms: [String],
    photos: [String],

    // Independent lifecycle for each appliance/service item. Parent booking
    // status remains as a compatibility summary for legacy screens.
    status: {
      type: String,
      default: "pending",
      enum: [
        "pending", "awaiting_assignment", "assigned", "accepted", "scheduled",
        "en_route", "arrived", "in_progress", "completed", "cancelled", "on_hold",
        "inspection_pending", "inspection_scheduled", "inspection_in_progress",
        "inspection_completed", "diagnosis_completed", "parts_check",
        "awaiting_quotation", "awaiting_customer_decision", "repair_approved",
        "repair_declined", "ready_for_repair", "repair_scheduled",
        "repair_in_progress", "payment_pending"
      ],
      index: true,
    },
    phase: { type: String, enum: ["core", "repair_phase_1", "repair_phase_2"], default: "core" },
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: "Technician", default: null },
    technicianName: String,
    assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Assignment", default: null },
    schedule: {
      date: Date,
      startTime: String,
      endTime: String,
      durationMinutes: Number,
      kind: { type: String, enum: ["service", "inspection", "repair"], default: "service" },
    },
    quotation: {
      parts: [{
        name: String,
        cost: Number,
        quantity: Number,
        toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool", default: null },
      }],
      laborCost: Number,
      laborCategory: { type: String, enum: ["minor", "standard", "complex", "major"], default: "standard" },
      totalCost: Number,
      notes: String,
      status: { type: String, enum: ["draft", "submitted", "approved", "declined", "revision_requested"], default: "draft" },
      createdAt: Date,
      decidedAt: Date,
    },
    partsUsed: [{ name: String, quantity: Number, unitCost: Number, toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool" }, usedAt: Date }],
    consumablesUsed: [{ name: String, quantity: Number, unitCost: Number, toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool" }, usedAt: Date }],
    equipmentAssignmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "EquipmentAssignment" }],
    serviceReportId: { type: mongoose.Schema.Types.ObjectId, ref: "ServiceReport", default: null },
    statusHistory: [{ status: String, changedAt: { type: Date, default: Date.now }, changedBy: { type: mongoose.Schema.Types.ObjectId }, changedByName: String, reason: String }],

    // Professional repair pricing workflow
    initialCost: Number, // Initial cost at booking time (diagnostic fee)
    finalCost: Number, // Final cost set by technician after diagnosis
    costUpdatedByTechnician: { type: Boolean, default: false },
    costUpdatedAt: Date,
    costUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Technician' }, // Who updated the cost
    diagnosisNotes: String, // Technician's diagnosis notes
    diagnosisCompletedAt: Date, // When diagnosis was completed

    // Pricing history for audit trail
    priceHistory: [{
      previousCost: Number,
      newCost: Number,
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Technician' },
      updatedAt: { type: Date, default: Date.now },
      reason: String
    }],

    // ── Per-Unit Inspection (for multi-unit projects) ──────────────────────
    // When quantity > 1, each unit can have its own inspection/diagnosis.
    // `units[]` tracks individual unit status within this service group.
    units: [{
      unitIndex: { type: Number, required: true },   // 1-based index within this service
      label: { type: String, trim: true },            // e.g. "Unit 1", "Unit 2" (auto or custom)
      status: {
        type: String,
        enum: ["pending", "inspected", "in_progress", "completed", "skipped"],
        default: "pending",
      },
      // Per-unit inspection data
      inspection: {
        scheduledDate: Date,
        completedAt: Date,
        technicianId: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
        findings: String,
        severity: { type: String, enum: ["", "minor", "major", "critical"] },
        damagedParts: [String],
        recommendedAction: String,
        photos: [String],
        notes: String,
      },
      // Per-unit diagnosis
      diagnosis: {
        summary: String,
        confirmedDiagnoses: [String],
        laborCategory: { type: String, enum: ["minor", "standard", "complex", "major"], default: "standard" },
        laborDuration: String,
        technicianId: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
        completedAt: Date,
      },
      // Per-unit quotation (parts + labor for this specific unit)
      quotation: {
        parts: [{
          name: String,
          cost: Number,
          quantity: Number,
          toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool", default: null },
        }],
        laborCost: Number,
        laborCategory: { type: String, enum: ["minor", "standard", "complex", "major"], default: "standard" },
        totalCost: Number,
        notes: String,
      },
      // Per-unit parts used during repair
      partsUsed: [{
        name: String,
        quantity: Number,
        unitCost: Number,
        toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool" },
        usedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
        usedAt: Date,
      }],
      // Per-unit completion tracking
      completedAt: Date,
      completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
      completionNotes: String,
    }],
  }],
  serviceChangeRequests: [{
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    requestedByName: String,
    requestedAt: { type: Date, default: Date.now },
    reason: { type: String, trim: true, maxlength: 1000 },
    status: { type: String, enum: ["pending", "approved", "rejected", "schedule_proposed", "customer_accepted_schedule", "customer_rejected_schedule"], default: "pending", index: true },
    changeType: { type: String, enum: ["direct_edit", "change_request"], default: "change_request" },
    beforeServices: [{ type: mongoose.Schema.Types.Mixed }],
    proposedServices: [{ type: mongoose.Schema.Types.Mixed }],
    summary: {
      added: { type: Number, default: 0 },
      edited: { type: Number, default: 0 },
      removed: { type: Number, default: 0 },
    },
    // Schedule selected by the customer as part of this same change request.
    // This is distinct from proposedSchedule, which is an admin counterproposal.
    requestedSchedule: { date: Date, startTime: String, endTime: String, notes: String },
    proposedSchedule: { date: Date, startTime: String, endTime: String, notes: String },
    adminDecision: { decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, decidedByName: String, decidedAt: Date, reason: String },
    technicianAcknowledgedAt: Date,
    technicianAcknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
  }],
  totalPrice: { type: Number }, // Total price for multi-service bookings
  totalInitialCost: { type: Number }, // Sum of all initial costs
  totalFinalCost: { type: Number }, // Sum of all final costs (after technician updates)
  repairIssues: { type: String }, // Combined repair issues for multi-service bookings

  // Pricing workflow for single service bookings (legacy support)
  initialCost: { type: Number }, // Initial diagnostic/service call fee at booking
  finalCost: { type: Number }, // Final cost set by technician after diagnosis
  costUpdatedByTechnician: { type: Boolean, default: false },
  costUpdatedAt: { type: Date },
  diagnosisNotes: { type: String }, // Technician's diagnosis notes

  // estimated fee (servicePrice + travel fare) stored when booking created
  estimatedFee: { type: Number },
  travelFare: { type: Number },
  travelTime: { type: Number }, // minutes estimated from technician to customer

  // when booking a repair, user can describe the issue they are facing
  issueDescription: { type: String },

  // optional image associated with this booking (e.g. photo of issue or location)
  imageUrl: { type: String },

  // technician proof-of-completion photo (uploaded when job is marked completed)
  proofPhoto: { type: String },

  bookingDate: { type: Date, required: true },
  startTime: { type: String },
  endTime: { type: String },
  selectedTimeLabel: { type: String }, // exact slot text selected by customer in services.ejs

  // ── Large-Scale / Project Booking ────────────────────────────────────────
  // When a booking exceeds the standard appointment threshold (quantity × per-unit
  // duration), it becomes a project: scheduled across multiple working days by the
  // operations team instead of a single time slot.
  isProject: { type: Boolean, default: false },

  // Repair requests may involve multiple units; quantity captured at top level too.
  quantity: { type: Number, default: 1, min: 1, max: 40 },

  // Customer-provided scheduling preferences (not a confirmed schedule).
  projectScheduling: {
    preferredStartDate: { type: Date },
    preferredWorkingDays: [String], // e.g. ["monday","tuesday"]
    preferredWorkingHours: {
      start: String, // "morning" | "afternoon"
      end: String,
    },
    preferredCompletionDeadline: { type: Date },
    estimatedTotalHours: { type: Number },
  },

  // ── Work Order Number ───────────────────────────────────────────────────
  // Unique identifier for repair work orders (e.g. WO-2026-000123)
  workOrderNumber: { type: String, unique: true, sparse: true },

  // ── Unit Information (for repair requests) ──────────────────────────────
  unitInfo: {
    unitType: String,       // e.g. "Split Type Aircon", "Refrigerator"
    brand: String,          // e.g. "Carrier"
    model: String,          // e.g. "42KDPV48"
    hp: Number,             // HP rating for aircon services
    hpDescription: String,  // e.g. "1.5 HP Split Type"
    problemDescription: String,
    photos: [String],       // URLs to uploaded photos
  },

  // ── Customer Preferred Schedule (repair requests) ──────────────────────
  preferredDate: { type: Date },    // customer's preferred inspection date
  preferredTime: { type: String },  // customer's preferred inspection time slot

  // ── Inspection / Diagnosis ──────────────────────────────────────────────
  inspection: {
    scheduledDate: Date,
    scheduledTime: String,
    completedAt: Date,
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
    findings: String,
    severity: { type: String, enum: ["", "minor", "major", "critical"] },
    damagedParts: [String],
    recommendedAction: String,
    photos: [String],
    laborRequired: String,
    estimatedRepairCost: Number,
    findingsChecklist: [String],
    actionsChecklist: [String],
  },

  // ── Diagnosis (technician's formal diagnosis after inspection) ──────────
  diagnosis: {
    findings: String,
    diagnosisSummary: String,
    confirmedDiagnoses: [String],
    repairAction: String,
    replacementPartsRequired: { type: Boolean, default: false },
    requiredParts: [{
      name: String,
      quantity: Number,
      cost: Number, // legacy alias of sellingPrice
      sellingPrice: Number,
      purchasePrice: Number,
      toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool", default: null },
      itemType: { type: String, default: "part" },
    }],
    laborDuration: String,
    laborCost: Number,
    laborCategory: { type: String, enum: ["minor", "standard", "complex", "major"], default: "standard" },
    completedAt: Date,
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
  },

  // ── Quotation ───────────────────────────────────────────────────────────
  quotation: {
    parts: [{
      name: String,
      cost: Number,
      sellingPrice: Number,
      purchasePrice: Number,
      quantity: Number,
      toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool", default: null },
      itemType: { type: String, default: "part" },
      source: { type: String, enum: ["inventory", "external_purchase"], default: "inventory" },
    }],
    laborCost: Number,
    laborCategory: { type: String, enum: ["minor", "standard", "complex", "major"], default: "standard" },
    repairAction: String,
    replacementPartsRequired: { type: Boolean, default: false },
    totalCost: Number,
    notes: String,
    createdAt: Date,
    expiresAt: Date,
  },

  // ── Customer Approval ───────────────────────────────────────────────────
  approval: {
    status: { type: String, enum: ["pending", "approved", "declined"], default: "pending" },
    decidedAt: Date,
    reason: String,
  },

  // ── Parts Reservation ───────────────────────────────────────────────────
  partsReservation: [{
    partName: String,
    partNumber: String,
    quantity: Number,
    unitCost: Number,
    status: { type: String, enum: ["reserved", "ordered", "installed"], default: "reserved" },
    reservedAt: Date,
  }],

  // ── Parts Request (for out-of-stock items) ─────────────────────────────
  partsRequest: {
    status: { type: String, enum: ["pending", "procuring", "received", "cancelled"], default: "pending" },
    requestedAt: Date,
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    resumeStatus: { type: String },
    completedAt: Date,
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    items: [{
      toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool" },
      itemName: String,
      requestedQty: Number,
      availableQty: { type: Number, default: 0 },
      status: { type: String, enum: ["waiting", "ordered", "received"], default: "waiting" },
      receivedAt: Date,
    }],
  },

  // ── Local Purchase (technician buys missing parts from external supplier) ──
  localPurchase: [{
    partName: String,
    toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool", default: null },
    quotedCustomerPrice: Number,
    expectedPurchaseCost: Number,
    actualPurchaseCost: Number,
    source: { type: String, default: "External Supplier" },
    supplierName: String,
    supplierAddress: String,
    supplierContact: String,
    supplierAvailabilityConfirmed: { type: Boolean, default: false },
    purchaseByType: { type: String, enum: ["technician", "customer"], default: "technician" },
    purchasedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
    purchasedByName: String,
    purchaseStatus: { type: String, enum: ["pending", "awaiting_customer", "purchased", "receipt_uploaded", "verified", "rejected"], default: "pending" },
    receiptUrl: String,
    purchasedAt: Date,
    verifiedAt: Date,
    adminVerificationStatus: { type: String, enum: ["not_required", "pending", "approved", "rejected", "correction_requested"], default: "pending" },
    notes: String,
  }],

  // ── Warranty ────────────────────────────────────────────────────────────
  warranty: {
    days: { type: Number, default: 0 },
    startDate: Date,
    endDate: Date,
    status: { type: String, enum: ["active", "expired", "claimed"], default: null },
    claimIssue: { type: String, trim: true },
    claimedAt: Date,
    // Immutable per-service terms captured when work is completed. The legacy
    // top-level dates remain as the booking-level coverage summary.
    coverages: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },

  // ── Repair Completion Data (materials used, actions performed) ────────
  repairCompletion: {
    partsInstalled: [{
      name: String,
      quantity: { type: Number, default: 1 },
      unit: { type: String, default: "pcs" },
    }],
    actionsPerformed: [String],
    completionNotes: String,
    completedAt: Date,
  },

  // ── Follow-Up ───────────────────────────────────────────────────────────
  followUp: {
    scheduledDate: Date,
    completedAt: Date,
    notes: String,
  },

  // Preventive-maintenance bookings keep the normal booking lifecycle while
  // linking back to the customer's equipment and one maintenance cycle.
  maintenance: {
    isMaintenance: { type: Boolean, default: false, index: true },
    assetId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerAsset", default: null },
    scheduleId: { type: mongoose.Schema.Types.ObjectId, ref: "MaintenanceSchedule", default: null },
    nextRecommendedDays: { type: Number, min: 30, max: 730, default: 90 },
    nextRecommendationNotes: { type: String, trim: true, maxlength: 1000, default: "" },
  },

  // ── Scheduling Request (customer preferred dates for repair) ────────────
  schedulingRequest: {
    preferredDates: [Date],
    preferredTime: String,
    status: { type: String, enum: ['pending', 'confirmed', 'rescheduled'], default: 'pending' },
    scheduledDate: Date,
    scheduledTime: String,
    scheduledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    notes: String,
    createdAt: Date,
  },

  // ── Customer Preferred Schedule (repair-today-choice flow) ─────────────
  preferredSchedule: {
    dates: [{ type: Date }],
    timeWindow: { type: String, enum: ['morning', 'afternoon', 'any'], default: 'any' },
    submittedAt: { type: Date },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },

  // ── Repair Schedule Decision (today vs later) ──────────────────────────
  repairSchedule: {
    preference: { type: String, enum: ['today', 'later'] },
    decidedAt: { type: Date },
  },

  // lifecycle of a booking across the system.
  //   Core Service statuses:
  //     pending               – initial booking request (payment unverified)
  //     rejected              – admin rejected the booking (invalid payment, etc.)
  //     payment_verified      – admin verified payment, ready for assignment
  //     awaiting_assignment   – in assignment queue, no technician assigned yet
  //     assigned              – technician assigned, waiting for acceptance
  //     pending_reassignment  – assigned technician declined, needs new assign
  //     confirmed             – technician accepted the assignment
  //     scheduled             – confirmed and date/time assigned (paid in full)
  //     on-the-way            – technician is en route
  //     arrived               – technician arrived at location
  //     in-progress           – technician has started work
  //     completed             – service finished
  //     cancelled             – booking was voided
  //     re-scheduled          – appointment date/time was changed
  //   Enterprise Repair (Inspection-First) statuses:
  //     repair_requested        – customer submitted a repair request
  //     pending_inspection      – admin reviewing request before scheduling
  //     inspection_scheduled    – inspector/technician assigned for inspection
  //     inspection_in_progress  – technician is performing on-site inspection
  //     inspection_completed    – technician finished diagnosis
  //     awaiting_approval       – quotation sent, waiting customer decision
  //     repair_approved         – customer approved the quotation
  //     repair_declined         – customer declined the quotation
  //     waiting_parts           – parts not available in inventory
  //     parts_reserved          – parts reserved from inventory
  //     ready_for_repair        – parts ready, can schedule or start repair
  //     repair_scheduled        – repair appointment scheduled
  //     repair_in_progress      – technician performing repair
  //     repair_completed        – repair finished
  //     under_warranty          – repair is under warranty period
  //     warranty_claim          – customer filed a warranty claim
  //     closed                  – terminal state (declined, completed, expired)
  status: {
    type: String,
    enum: [
      "pending",
      "rejected",
      "payment_verified",
      "awaiting_assignment",
      "assigned",
      "pending_reassignment",
      "confirmed",
      "scheduled",
      "on-the-way",
      "arrived",
      "waiting-for-customer",
      "no-show-reported",
      "in-progress",
      "completed",
      "cancelled",
      "no-show",
      "re-scheduled",
      "reschedule-required",
      "repair_requested",
      "pending_inspection",
      "inspection_scheduled",
      "inspection_in_progress",
      "inspection_completed",
      "awaiting_approval",
      "repair_approved",
      "repair_declined",
      "waiting_parts",
      "parts_reserved",
      "ready_for_repair",
      "repair_scheduled",
      "repair_in_progress",
      "repair_completed",
      "under_warranty",
      "warranty_claim",
      "closed",
    ],
    default: "pending",
  },
  // when an appointment is moved, record the reason
  rescheduleReason: { type: String },
  // Customer-driven reschedule authorization. The customer selects a slot
  // from the same capacity calendar as /services; no second admin approval.
  rescheduleAccessToken: { type: String, index: true, sparse: true },
  rescheduleAccessExpiry: { type: Date },
  rescheduleAccessStatus: {
    type: String,
    enum: ["allowed", "submitted", "cancelled", "expired"],
  },
  rescheduleSource: {
    type: String,
    enum: ["customer", "admin_on_behalf_of_customer"],
  },
  rescheduleReasonType: {
    type: String,
    enum: ["no_show", "customer_request", "cancelled", "admin_approved"],
  },
  rescheduleHistory: [{
    previousDate: { type: Date },
    previousTime: { type: String },
    newDate: { type: Date },
    newTime: { type: String },
    reasonType: { type: String, enum: ["no_show", "customer_request", "cancelled", "admin_approved"] },
    source: { type: String, enum: ["customer", "admin_on_behalf_of_customer"] },
    authorizedAt: { type: Date },
    authorizedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    selectedAt: { type: Date },
  }],
  // when an appointment is cancelled, record the reason
  cancellationReason: { type: String },

  // Admin decisions made in the Booking Resolution Center. The booking itself
  // remains the source of truth; these entries close only a specific exception.
  resolutionCases: [{
    issueType: {
      type: String,
      enum: ["no_show", "cancelled", "incomplete", "no_technician", "technician_issue", "schedule_conflict", "customer_reschedule", "past_date"],
      required: true,
    },
    sourceStatus: { type: String, required: true },
    state: { type: String, enum: ["closed", "rescheduled", "reassigned"], required: true },
    action: { type: String, enum: ["close", "reschedule", "reassign"], required: true },
    note: { type: String, trim: true, maxlength: 1000 },
    decidedAt: { type: Date, default: Date.now },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    decidedByName: { type: String },
  }],

  // ── Admin-Initiated Reschedule Proposal (awaiting customer response) ──────
  proposedReschedule: {
    proposedAt: { type: Date },
    proposedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    proposedByName: { type: String },
    date: { type: Date },
    time: { type: String },
    dateLabel: { type: String },
    timeLabel: { type: String },
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
    technicianName: { type: String },
    expiresAt: { type: Date },
    status: { type: String, enum: ["pending", "accepted", "rejected", "new_requested"], default: "pending" },
  },

  // ── Delay (overtime cascade) ─────────────────────────────────────────────
  // Set when a technician's earlier job overruns into this booking's slot.
  // Per product decision this is NOTIFY-ONLY: the customer is informed and
  // dispatch is alerted, but the appointment is not auto-rescheduled.
  delay: {
    delayed: { type: Boolean, default: false },
    delayedBy: { type: mongoose.Schema.Types.ObjectId, ref: "BookingService" },
    delayedAt: { type: Date },
    reason: { type: String },
    notifiedCustomer: { type: Boolean, default: false },
    notifiedAt: { type: Date },
  },

  // ── No-Show Reschedule Token ─────────────────────────────────────────────
  // Generated when technician marks customer as no-show.
  // Customer receives an email with a one-time link to reschedule or cancel.
  noShowRescheduleToken:  { type: String, index: true, sparse: true },
  noShowRescheduleExpiry: { type: Date },
  noShowRescheduleStatus: { type: String, enum: ['pending', 'rescheduled', 'cancelled'], default: 'pending' },
  noShowAt:               { type: Date },

  // ── No-Show Report (waiting-for-customer → no-show-reported → decision) ──
  // Filled when the technician reports that the customer was not available.
  // Holds evidence (contact attempts + arrival proof) and the admin decision.
  noShowReport: {
    reportedAt:        { type: Date },
    reportedBy:        { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reportedByName:    { type: String },
    contactAttempts:   { type: [String], default: [] },   // ['Call','SMS','In-app notification']
    arrivalProofUrl:   { type: String, trim: true },       // proof-of-arrival photo
    arrivalProofCapturedAt: { type: Date },
    arrivedAt:         { type: Date },                     // when tech arrived on site
    waitedMinutes:     { type: Number, default: 0 },       // minutes tech waited before reporting
    waitingUntil:      { type: Date },                     // arrivedAt + configured wait window
    reviewStatus:      { type: String, enum: ['pending', 'confirmed', 'rescheduled', 'cancelled'], default: 'pending' },
    decisionAt:        { type: Date },
    decisionBy:        { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    decisionByName:    { type: String },
    customerNotified:  { type: Boolean, default: false },
    customerNotifiedAt:{ type: Date },
  },

  // ── No-Show Fee (configurable policy applied on confirmation) ────────────
  noShowFeeType:   { type: String, enum: ['none', 'travel_fee', 'fixed_fee'], default: 'none' },
  noShowFeeAmount: { type: Number, default: 0, min: 0 },

  // when admin rejects booking, record the reason
  rejectionReason: { type: String },
  rejectionNote: { type: String },
  rejectedAt: { type: Date },
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  // reassignment tracking — counts how many times a technician declined/cancelled this booking
  reassignmentCount: { type: Number, default: 0 },
  // full history of technician cancellations/declines for this booking
  cancellationHistory: [{
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
    technicianName: { type: String },
    action: { type: String, enum: ["declined", "cancelled", "reassigned", "auto_reschedule"] },
    reason: { type: String },
    timestamp: { type: Date, default: Date.now },
  }],
  escalated: { type: Boolean, default: false },
  // when admin verifies payment
  paymentVerifiedAt: { type: Date },
  paymentVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  // assignment tracking
  assignedAt: { type: Date },
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Assignment" },
  // general notes about the booking (cancellation reasons, special instructions, etc.)
  notes: { type: String },
  // reschedule request from customer
  rescheduleRequest: {
    type: {
      requested: { type: Boolean, default: false },
      requestedDate: { type: String },
      requestedTime: { type: String },
      reason: { type: String },
      requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      requestedAt: { type: Date },
      status: { type: String, enum: ["pending", "approved", "rejected", "superseded"], default: "pending" },
      processedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      processedAt: { type: Date },
      rejectionReason: { type: String }
    },
    default: {}
  },

  // payment information
  paymentMethod: { type: String, enum: ["cod", "gcash", "other"], default: "cod" },

  // downpayment / proof information (customer-submitted when booking)
  gcashNumber: { type: String }, // raw mobile number entered by customer (optional reference)
  paymentReference: { type: String }, // text reference or note entered
  downpaymentPercentage: { type: Number, min: 1, max: 100 }, // policy snapshot at booking time
  downpaymentAmount: { type: Number }, // required for cash bookings
  paymentNotes: { type: String }, // optional special instructions (cash bookings)

  // payment status tracking
  paymentStatus: { type: String, enum: ["pending", "payment_collected", "waiting_for_remittance", "remitted", "verified", "rejected", "refunded", "paid", "failed", "partial"], default: "pending" },
  amountPaid: { type: Number, default: 0 },          // total collected so far (downpayment + any final)
  balanceAmount: { type: Number, default: 0 },       // remaining balance to collect on-site
  balanceCollected: { type: Boolean, default: false }, // true when technician collects final payment
  balanceCollectedAt: { type: Date },
  balanceCollectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },

  // refund tracking (set when cancellation involves a refund)
  refundStatus: {
    type: String,
    enum: ["none", "pending", "processing", "completed", "partial"],
    default: "none",
  },
  refundAmount: { type: Number, default: 0 },
  refundMethod: { type: String, enum: ["original", "gcash", "bank", "cash", "other"] },
  refundProofUrl: { type: String },
  refundNotes: { type: String },

  // repair quotation payment tracking (separate from inspection)
  repairPaymentCollected: { type: Boolean, default: false },
  repairPaymentAmount: { type: Number, default: 0 },
  repairPaymentMethod: { type: String },
  repairPaymentCollectedAt: { type: Date },
  repairPaymentCollectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
  repairPaymentProof: { type: String },

  // inspection fee tracking
  inspectionFeeCollected: { type: Boolean, default: false },
  inspectionFeeAmount: { type: Number, default: 0 },
  inspectionFeeDistanceFare: { type: Number, default: 0 },
  inspectionFeeTotalCollected: { type: Number, default: 0 },
  downpaymentAppliedToInspection: { type: Number, default: 0 },
  inspectionFeeMethod: { type: String },
  inspectionFeeCollectedAt: { type: Date },

  // Mixed-booking Phase 1 settlement. Core service is paid on the first
  // visit when every Core item is complete; the later Repair visit then
  // collects only the approved quotation.
  coreServicePaymentCollected: { type: Boolean, default: false },
  coreServicePaymentAmount: { type: Number, default: 0 },
  coreServicePaymentCashCollected: { type: Number, default: 0 },
  coreServicePaymentMethod: { type: String },
  coreServicePaymentCollectedAt: { type: Date },

  // if technician has been detected near customer, we send a one‑time notification
  arrivalNotified: { type: Boolean, default: false },

  // Delay tracking — set by overdueBookingScheduler when technician hasn't departed
  isDelayed: { type: Boolean, default: false, index: true },
  delayedAt: { type: Date },
  delayNotifiedAt: { type: Date },

  // Auto-fallback to reschedule — set by overdueBookingScheduler when a booking
  // in the assignment queue exceeds its scheduled time without a technician.
  // The booking is moved to pending_reassignment so admins can reschedule it.
  autoReschedulePending: { type: Boolean, default: false, index: true },
  autoRescheduleAt: { type: Date },
  autoRescheduleReason: { type: String },

  // Pre-schedule verification reminder — set once when a booking approaches its
  // scheduled time while still pending payment verification / technician assignment.
  verificationReminderAt: { type: Date },

  // optional external gateway tracking (kept for compatibility)
  paymentGatewayId: { type: String },
  paymentGatewayStatus: { type: String },

  // legacy fields kept for backwards compatibility
  paymentProof: { type: String }, // base64 data URL or URL to uploaded proof image
  gateway: { type: String, enum: ["gcash", "cod", "other"] },
  gatewayId: String,
  gatewayStatus: String,

  location: {
    address: String,
    lat: Number,
    lng: Number,
    coordinates: {
      type: { type: String, default: "Point" },
      coordinates: [Number],
    },
  },
  technicianLocation: {
    address: String,
    lat: Number,
    lng: Number,
    coordinates: {
      type: { type: String, default: "Point" },
      coordinates: [Number],
    },
  },

  // Distance and travel information
  distanceKm: { type: Number }, // Actual distance in kilometers
  travelDurationMinutes: { type: Number }, // Calculated travel time

  // Google Calendar sync metadata (server-side)
  googleCalendarId: { type: String },
  googleCalendarEventId: { type: String },
  googleCalendarHtmlLink: { type: String },

  // human-readable unique booking reference (e.g. RACS-20260301-AB3X)
  bookingReference: { type: String, unique: true, sparse: true },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date },
  completedAt: { type: Date, default: null, index: true },

  // optional feedback/rating provided by customer after service
  customerRating: { type: Number, min: 1, max: 5, default: null },
  customerRatingComment: { type: String, default: null },

  // ── Enterprise Repair: Priority & Audit Trail ──────────────────────────────
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium',
    index: true
  },

  // Full status history — every transition is recorded for audit
  statusHistory: [{
    fromStatus: { type: String },
    toStatus: { type: String, required: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'statusHistory.changedByModel' },
    changedByModel: { type: String, enum: ['User', 'Technician', 'System'] },
    changedByName: { type: String },
    reason: { type: String },
    notes: { type: String },
    timestamp: { type: Date, default: Date.now },
    metadata: { type: mongoose.Schema.Types.Mixed }
  }],

  // ── Enterprise Repair: SLA Tracking ────────────────────────────────────────
  slaTracking: {
    responseTarget: { type: Date },       // When first response is expected
    resolutionTarget: { type: Date },     // When repair should be completed
    escalationTarget: { type: Date },     // When to auto-escalate
    responseAt: { type: Date },           // When technician first acknowledged
    resolutionAt: { type: Date },         // When repair was completed
    responseBreached: { type: Boolean, default: false },
    resolutionBreached: { type: Boolean, default: false },
    escalationLevel: { type: Number, default: 0 }  // 0=none, 1=supervisor, 2=manager
  },

  // ── Enterprise Repair: AI Technician Assistant ───────────────────────────────
  // Decision-support tool: provides preliminary recommendations, NOT a final diagnosis
  technicianAssistant: {
    generatedAt: { type: Date },
    source: { type: String, enum: ['ai', 'ai-groq', 'fallback', 'mixed'] },
    provider: { type: String, enum: ['gemini', 'groq', 'local', 'mixed'] },
    model: { type: String },
    webResearchFetched: { type: Boolean, default: false },
    webResearchUsed: { type: Boolean, default: false },
    webSources: [{ type: String }],
    summary: { type: String },
    probableCauses: [{ type: mongoose.Schema.Types.Mixed }],
    inspectionChecklist: [{ type: mongoose.Schema.Types.Mixed }],
    suggestedTools: [{ type: mongoose.Schema.Types.Mixed }],
    possibleParts: [{ type: mongoose.Schema.Types.Mixed }],
    repairComplexity: { type: String },
    estimatedDurationMinutes: { type: Number },
    safetyReminders: [String],
    additionalNotes: { type: String },
    // One preliminary reference per selected repair service/appliance. The
    // aggregate fields above remain for backwards-compatible screens.
    serviceAnalyses: [{ type: mongoose.Schema.Types.Mixed }],
    technicianNotes: { type: String },    // Technician can add their own notes after on-site inspection
    // Optional contingency parts the technician declares they will carry.
    // These are not confirmed repair parts, reservations, or customer charges.
    carriedPossibleParts: [{ type: mongoose.Schema.Types.Mixed }],
    verifiedByTechnician: { type: Boolean, default: false },
    verifiedAt: { type: Date }
  },

  // Technician pre-departure checklist for repair visits.
  repairPreparation: {
    confirmed: { type: Boolean, default: false },
    confirmedAt: { type: Date },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Technician' }
  },

  // Technician-owned preparation for standard/core service bookings.
  servicePreparation: {
    confirmed: { type: Boolean, default: false },
    confirmedAt: { type: Date },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Technician' },
    recommendationGeneratedAt: { type: Date },
    // Optional AI contingency parts physically confirmed in the technician's
    // possession. These remain references, not quoted/required repair parts.
    aiContingencyParts: [{
      name: { type: String, trim: true },
      quantity: { type: Number, min: 1, default: 1 },
      serviceName: { type: String, trim: true },
      confirmedBroughtAt: { type: Date },
      confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Technician' }
    }],
    items: [{
      inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tool' },
      name: { type: String, trim: true },
      kind: { type: String, enum: ['equipment', 'consumable'] },
      quantity: { type: Number, min: 1, default: 1 },
      recommended: { type: Boolean, default: false }
    }]
  },

  // ── Enterprise Repair: Preventive Maintenance Tips ──────────────────────
  preventiveMaintenance: [String],

  // ── Enterprise Repair: Previous Repair History (for recurring issues) ───
  previousRepairs: [{
    date: { type: String },
    issue: { type: String },
    description: { type: String },
    technician: { type: String },
    cost: { type: Number },
    recurring: { type: Boolean, default: false }
  }],

  // ── Enterprise Repair: AI-Generated Repair Notes ────────────────────────
  aiGeneratedNotes: { type: String },

  // ── Enterprise Repair: Triage & Assignment ─────────────────────────────────
  triage: {
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedAt: { type: Date },
    technicianSkillMatch: { type: Boolean, default: false },
    technicianAvailabilityConfirmed: { type: Boolean, default: false },
    customerPreferredDateHonored: { type: Boolean, default: false },
    notes: { type: String }
  }
});

// virtual helpers for views/queries
bookingSchema.virtual("customerName").get(function () {
  if (this.customer && this.customer.name) return this.customer.name;
  return undefined;
});
bookingSchema.virtual("customerEmail").get(function () {
  if (this.customer && this.customer.email) return this.customer.email;
  return undefined;
});
bookingSchema.virtual("technicianName").get(function () {
  // prefer stored snapshot
  if (this.technician && this.technician.name) return this.technician.name;
  // if the document was populated and the referenced technician/user object
  // includes a name property, use that too (allows populate("technicianId")).
  if (this.technicianId && typeof this.technicianId === "object") {
    if (this.technicianId.name) return this.technicianId.name;
    if (this.technicianId.fullName) return this.technicianId.fullName;
    if (this.technicianId.firstName || this.technicianId.lastName) {
      return (
        (this.technicianId.firstName || "") +
        " " +
        (this.technicianId.lastName || "")
      ).trim();
    }
  }
  return undefined;
});
// helpers that expose the chosen service information when serviceId has been populated
bookingSchema.virtual("serviceName").get(function () {
  if (this.service && this.service.name) return this.service.name;
  if (this.serviceId && this.serviceId.name) return this.serviceId.name;
  return undefined;
});
bookingSchema.virtual("serviceDescription").get(function () {
  if (this.service && this.service.description) return this.service.description;
  if (this.serviceId && this.serviceId.description) return this.serviceId.description;
  return undefined;
});


// validation: ensure cash/GCash fields are present depending on method
bookingSchema.pre("validate", function () {
  // require downpayment when using cash (cod)
  if (this.paymentMethod === "cod") {
    if (!this.downpaymentAmount || this.downpaymentAmount <= 0) {
      this.invalidate(
        "downpaymentAmount",
        "Downpayment amount is required for cash bookings",
      );
    }
    // Reference number is no longer required for cash bookings
  }
  // require reference/proof for gcash entries (helper, though controller also checks)
  if (this.paymentMethod === "gcash") {
    if (this.paymentReference && String(this.paymentReference).length < 3) {
      this.invalidate(
        "paymentReference",
        "GCash reference appears too short",
      );
    }
  }

  // Validate multi-service bookings
  if (this.isMultiService && (!this.services || this.services.length === 0)) {
    this.invalidate(
      "services",
      "Multi-service booking must have at least one service",
    );
  }
  const serviceUnits = Array.isArray(this.services) && this.services.length
    ? this.services.reduce((sum, service) => sum + (Number(service.quantity) || 1), 0)
    : Number(this.quantity || 1);
  if (serviceUnits > 40) this.invalidate("services", "A booking can contain at most 40 units across all services");
  if (serviceUnits >= 8) {
    this.quantity = serviceUnits;
    this.isProject = true;
  }
});

// Helper method: Calculate total costs for multi-service bookings
bookingSchema.methods.calculateTotalCosts = function () {
  if (!this.services || this.services.length === 0) {
    return {
      totalInitialCost: this.initialCost || 0,
      totalFinalCost: this.finalCost || 0,
      totalPrice: this.totalPrice || 0
    };
  }

  let totalInitial = 0;
  let totalFinal = 0;
  let hasUndiagnosedRepairs = false;

  this.services.forEach(service => {
    const quantity = Math.max(1, Number(service.quantity) || 1);
    const initialUnit = Number(service.initialCost ?? service.unitPrice ?? 0);
    const initialLine = initialUnit * quantity;
    totalInitial += initialLine;

    if (service.finalCost != null && service.costUpdatedByTechnician) {
      totalFinal += Number(service.finalCost) * quantity;
    } else if (service.type === 'repair') {
      // Until diagnosis, keep the inspection/diagnostic amount as the
      // provisional customer total without claiming it is a final quote.
      hasUndiagnosedRepairs = true;
      totalFinal += initialLine;
    } else {
      totalFinal += Number(service.totalPrice ?? (Number(service.unitPrice) || 0) * quantity);
    }
  });

  // Add travel fare to totals
  if (this.travelFare) {
    totalInitial += this.travelFare;
    totalFinal += this.travelFare;
  }

  return {
    totalInitialCost: totalInitial,
    totalFinalCost: hasUndiagnosedRepairs ? null : totalFinal,
    totalPrice: totalFinal,
    hasUndiagnosedRepairs
  };
};

// Helper method: Update service cost (for technician dashboard)
bookingSchema.methods.updateServiceCost = function (serviceIndex, newCost, technicianId, diagnosisNotes, reason) {
  if (!this.services || !this.services[serviceIndex]) {
    throw new Error('Invalid service index');
  }

  const service = this.services[serviceIndex];
  const previousCost = service.finalCost || service.initialCost;

  // Add to price history
  if (!service.priceHistory) {
    service.priceHistory = [];
  }
  service.priceHistory.push({
    previousCost,
    newCost,
    updatedBy: technicianId,
    updatedAt: new Date(),
    reason: reason || 'Diagnosis completed'
  });

  // Update service cost
  service.finalCost = newCost;
  service.costUpdatedByTechnician = true;
  service.costUpdatedAt = new Date();
  service.costUpdatedBy = technicianId;
  service.diagnosisCompletedAt = new Date();

  if (diagnosisNotes) {
    service.diagnosisNotes = diagnosisNotes;
  }

  // Recalculate total costs
  const totals = this.calculateTotalCosts();
  this.totalInitialCost = totals.totalInitialCost;
  this.totalFinalCost = totals.totalFinalCost;
  this.totalPrice = totals.totalPrice;

  return this;
};

// Helper method: Check if all repair services have been diagnosed
bookingSchema.methods.allRepairsDiagnosed = function () {
  if (!this.services || this.services.length === 0) {
    return this.costUpdatedByTechnician || false;
  }

  const repairServices = this.services.filter(s => s.type === 'repair');
  if (repairServices.length === 0) {
    return true; // No repairs to diagnose
  }

  return repairServices.every(s => s.costUpdatedByTechnician);
};

// ── Multi-Unit: Extract unit groups for project creation ─────────────────────
// Builds an array of appliance groups from the services[] array.
// Each group represents a distinct appliance type with its unit count and details.
bookingSchema.methods.getUnitGroups = function () {
  if (!this.services || this.services.length === 0) {
    // Single-service booking: use top-level unitInfo
    return [{
      groupIndex: 0,
      serviceId: this.serviceId,
      serviceName: this.service?.name || 'Service',
      serviceType: this.serviceType || 'repair',
      unitType: this.unitInfo?.unitType || 'Unknown',
      brand: this.unitInfo?.brand || this.brand || '',
      model: this.unitInfo?.model || '',
      applianceType: this.applianceType || '',
      applianceTypeName: this.applianceTypeName || '',
      hp: null,
      hpDescription: '',
      problemDescription: this.unitInfo?.problemDescription || this.issueDescription || '',
      quantity: this.quantity || 1,
      unitPrice: this.servicePrice || 0,
      totalPrice: this.totalPrice || 0,
      repairIssue: this.issueDescription || '',
      duration: this.serviceDurationMinutes || 60,
      units: this.services?.[0]?.units || [],
    }];
  }

  return this.services.map((svc, idx) => ({
    groupIndex: idx,
    serviceId: svc.serviceId,
    serviceName: svc.name,
    serviceType: svc.type || 'repair',
    unitType: svc.applianceTypeName || svc.airconTypeName || svc.name || 'Unknown',
    brand: svc.brand || '',
    model: svc.model || '',
    applianceType: svc.applianceType || svc.airconType || '',
    applianceTypeName: svc.applianceTypeName || svc.airconTypeName || '',
    hp: svc.hp || null,
    hpDescription: svc.hpDescription || '',
    problemDescription: svc.problemDescription || svc.repairIssue || '',
    quantity: svc.quantity || 1,
    unitPrice: svc.unitPrice || 0,
    totalPrice: svc.totalPrice || 0,
    repairIssue: svc.repairIssue || '',
    duration: svc.duration || 60,
    units: svc.units || [],
  }));
};

// ── Enterprise: Record status change in audit trail ─────────────────────────
bookingSchema.methods.recordStatusHistory = function (opts = {}) {
  const prevStatus = this.status;
  const entry = {
    fromStatus: opts.fromStatus || prevStatus,
    toStatus: opts.toStatus || this.status,
    changedBy: opts.changedBy || null,
    changedByModel: opts.changedByModel || 'System',
    changedByName: opts.changedByName || 'System',
    reason: opts.reason || '',
    notes: opts.notes || '',
    timestamp: new Date(),
    metadata: opts.metadata || {}
  };
  if (!this.statusHistory) this.statusHistory = [];
  this.statusHistory.push(entry);

  // ── Enterprise: mirror every status change to the global audit log ────────
  try {
    const { logEvent } = require('../utils/audit');
    logEvent({
      actor: opts.changedBy || null,
      action: 'booking.status_change',
      module: 'BookingService',
      details: {
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        reason: opts.reason || '',
        notes: opts.notes || '',
        metadata: opts.metadata || {},
        bookingReference: this.bookingReference,
        bookingId: this._id ? this._id.toString() : null,
        actorRole: opts.changedByModel || 'System',
        actorName: opts.changedByName || 'System',
      },
      entityId: this._id || null,
      entityType: 'BookingService',
      category: 'booking',
      actionType: 'status_change',
      actorRole: opts.changedByModel || 'System',
      actorName: opts.changedByName || 'System',
    });
  } catch (_) { /* non-fatal */ }

  return entry;
};

// ── Enterprise: Safe status transition with audit trail ─────────────────────
bookingSchema.methods.transitionStatus = function (newStatus, opts = {}) {
  const { StatusTransitions } = require('./BookingStatus');
  const allowed = StatusTransitions[this.status];
  if (!allowed || !allowed.includes(newStatus)) {
    throw new Error(`Invalid status transition: ${this.status} → ${newStatus}`);
  }
  const entry = this.recordStatusHistory({
    fromStatus: this.status,
    toStatus: newStatus,
    ...opts
  });
  this.status = newStatus;
  return entry;
};

// make sure virtuals are included when converting to objects/json
bookingSchema.set("toObject", { virtuals: true });
bookingSchema.set("toJSON", { virtuals: true });

// keep updatedAt in sync and maintain serviceModel based on serviceType
// also populate/refresh customer/technician snapshots if ids are provided
bookingSchema.pre("save", async function () {
  // map old simple type to actual model name used for refPath
  if (this.serviceType === "core") this.serviceModel = "CoreService";
  else if (this.serviceType === "repair") this.serviceModel = "RepairService";

  // Auto-generate work order number for repair requests
  if (!this.workOrderNumber && this.serviceModel === "RepairService") {
    try {
      const count = await mongoose.model("BookingService").countDocuments({ serviceModel: "RepairService" });
      this.workOrderNumber = `WO-${new Date().getFullYear()}-${String(count + 1).padStart(6, '0')}`;
    } catch (e) {
      console.error("Failed to generate work order number:", e.message);
    }
  }

  // if user switches category away from repair, clear any entered issue
  if (this.serviceType !== "repair") this.issueDescription = undefined;

  // Only snapshot customer when customerId changed or new doc (skip on status-only updates)
  if (this.customerId && (this.isNew || this.isModified("customerId"))) {
    try {
      const User = mongoose.model("User");
      const u = await User.findById(this.customerId).lean();
      if (u) {
        const constructedName = `${u.firstName || ""} ${u.lastName || ""}`.trim();
        this.customer = {
          _id: u._id,
          name: constructedName || "Customer Name",
          email: u.email || "customer@example.com",
          phone: u.phone || u.mobile || "09123456789",
          address: u.address || "Default Address",
        };
      }
    } catch (e) {
      console.error("Error fetching customer:", e.message);
    }
  }

  // Only snapshot service when serviceId changed or new doc
  if (this.serviceId && (this.isNew || this.isModified("serviceId"))) {
    try {
      const Model = mongoose.model(this.serviceModel || "CoreService");
      const svc = await Model.findById(this.serviceId).lean();
      if (svc) {
        this.service = {
          _id: svc._id,
          name: svc.name || svc.title || "",
          description: svc.description || svc.commonFaults || "",
          basePrice: svc.basePrice || svc.laborPerHour || 0,
        };
        if (svc.basePrice !== undefined) this.servicePrice = svc.basePrice;
        if (svc.durationMinutes !== undefined)
          this.serviceDurationMinutes = svc.durationMinutes;
        else if (svc.estimatedDurationMinutes !== undefined)
          this.serviceDurationMinutes = svc.estimatedDurationMinutes;
      }
    } catch (e) {
      /* ignore snapshot failure */
    }
  }

  // if travelFare exists, recalc estimated fee after servicePrice set
  if (this.travelFare != null) {
    if (this.isMultiService) {
      this.estimatedFee = (this.totalPrice || 0);
    } else {
      const base = this.servicePrice || (this.service && this.service.basePrice) || 0;
      this.estimatedFee = base + (this.travelFare || 0);
    }
  }

  // Only snapshot technician when technicianId changed or new doc
  if (this.technicianId && (this.isNew || this.isModified("technicianId"))) {
    try {
      const Technician = mongoose.model("Technician");
      const tech = await Technician.findById(this.technicianId).lean();
      if (tech) {
        this.technician = {
          _id: tech._id,
          name: tech.name || "Technician Name",
          email: tech.userEmail || tech.email || "technician@example.com",
          phone: tech.phone || tech.mobile || "0987654321",
        };
      }
    } catch (e) {
      console.error("Error fetching technician:", e.message);
    }
  }

  // Service items are the source of truth for both single- and multi-item
  // bookings. Legacy records without services continue using top-level totals.
  if (this.services && this.services.length > 0) {
    const totals = this.calculateTotalCosts();
    this.totalInitialCost = totals.totalInitialCost;
    this.totalFinalCost = totals.totalFinalCost;
    this.totalPrice = totals.totalPrice;
  }

  this.updatedAt = new Date();
});

// Indexes for performance optimization
bookingSchema.index({ technicianId: 1, bookingDate: 1 }); // For fetching technician's bookings by date
bookingSchema.index({ customerId: 1, status: 1 }); // For customer booking history
bookingSchema.index({ status: 1, bookingDate: 1 }); // For filtering by status and date
// bookingReference and workOrderNumber already have unique: true which creates an index
bookingSchema.index({ serviceModel: 1, status: 1 }); // For repair queue queries
bookingSchema.index({ 'services.type': 1, 'services.costUpdatedByTechnician': 1 }); // For repair workflow queries
bookingSchema.index({ priority: 1, status: 1 }); // For priority-based repair queue
bookingSchema.index({ 'slaTracking.responseTarget': 1, 'slaTracking.responseBreached': 1 }); // For SLA monitoring
bookingSchema.index({ 'slaTracking.resolutionTarget': 1, 'slaTracking.resolutionBreached': 1 }); // For resolution SLA
bookingSchema.index({ 'technicianAssistant.repairComplexity': 1 }); // For complexity-based queries
bookingSchema.index({ createdAt: -1 }); // For recent repairs listing
bookingSchema.index({ status: 1, updatedAt: -1 }); // For completion-based revenue reporting
bookingSchema.index({ customerRating: 1, updatedAt: -1 }); // For service-rating analytics and legacy review reconciliation
bookingSchema.index({ technicianId: 1, customerRating: 1, updatedAt: -1 }); // For technician quality reporting

module.exports = mongoose.model("BookingService", bookingSchema);
