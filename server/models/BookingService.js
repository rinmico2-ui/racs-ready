const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema({
  // keep a reference to the user and technician so we can still run joins/query
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  technicianId: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },

  // snapshots of the customer/technician info at the time of booking
  // this allows us to show the name/contact even if either account is later
  customer: {
    _id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    name: String,
    email: String,
    phone: String,
    address: String,
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

  // Multi-service booking support
  isMultiService: { type: Boolean, default: false },
  services: [{
    serviceId: { type: mongoose.Schema.Types.ObjectId },
    name: String,
    type: String, // 'core' or 'repair'
    quantity: Number,
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
        laborCategory: { type: String, enum: ["standard", "complex", "major"], default: "standard" },
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
        laborCategory: { type: String, enum: ["standard", "complex", "major"], default: "standard" },
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
  quantity: { type: Number, default: 1 },

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
    requiredParts: [{ name: String, quantity: Number, cost: Number }],
    laborDuration: String,
    laborCost: Number,
    laborCategory: { type: String, enum: ["standard", "complex", "major"], default: "standard" },
    completedAt: Date,
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
  },

  // ── Quotation ───────────────────────────────────────────────────────────
  quotation: {
    parts: [{
      name: String,
      cost: Number,
      quantity: Number,
      toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool", default: null },
    }],
    laborCost: Number,
    laborCategory: { type: String, enum: ["standard", "complex", "major"], default: "standard" },
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

  // ── Warranty ────────────────────────────────────────────────────────────
  warranty: {
    days: { type: Number, default: 30 },
    startDate: Date,
    endDate: Date,
    status: { type: String, enum: ["active", "expired", "claimed"], default: "active" },
    claimIssue: { type: String, trim: true },
    claimedAt: Date,
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
      "in-progress",
      "completed",
      "cancelled",
      "no-show",
      "re-scheduled",
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
  // when an appointment is cancelled, record the reason
  cancellationReason: { type: String },

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
    action: { type: String, enum: ["declined", "cancelled", "reassigned"] },
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
      status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
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
  downpaymentAmount: { type: Number }, // required for cash bookings
  paymentNotes: { type: String }, // optional special instructions (cash bookings)

  // payment status tracking
  paymentStatus: { type: String, enum: ["pending", "paid", "failed", "partial"], default: "pending" },
  amountPaid: { type: Number, default: 0 },          // total collected so far (downpayment + any final)
  balanceAmount: { type: Number, default: 0 },       // remaining balance to collect on-site
  balanceCollected: { type: Boolean, default: false }, // true when technician collects final payment
  balanceCollectedAt: { type: Date },
  balanceCollectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },

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
  inspectionFeeMethod: { type: String },
  inspectionFeeCollectedAt: { type: Date },

  // if technician has been detected near customer, we send a one‑time notification
  arrivalNotified: { type: Boolean, default: false },

  // Delay tracking — set by overdueBookingScheduler when technician hasn't departed
  isDelayed: { type: Boolean, default: false, index: true },
  delayedAt: { type: Date },
  delayNotifiedAt: { type: Date },

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
    source: { type: String, enum: ['ai', 'ai-groq', 'fallback'] },
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
    technicianNotes: { type: String },    // Technician can add their own notes after on-site inspection
    verifiedByTechnician: { type: Boolean, default: false },
    verifiedAt: { type: Date }
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
});

// Helper method: Calculate total costs for multi-service bookings
bookingSchema.methods.calculateTotalCosts = function () {
  if (!this.isMultiService || !this.services || this.services.length === 0) {
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
    // Add initial costs
    if (service.initialCost) {
      totalInitial += service.initialCost * (service.quantity || 1);
    } else if (service.unitPrice) {
      totalInitial += service.unitPrice * (service.quantity || 1);
    }

    // Add final costs (if technician has updated)
    if (service.finalCost) {
      totalFinal += service.finalCost * (service.quantity || 1);
    } else if (service.type === 'repair' && !service.costUpdatedByTechnician) {
      hasUndiagnosedRepairs = true;
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
    totalPrice: hasUndiagnosedRepairs ? totalInitial : totalFinal,
    hasUndiagnosedRepairs
  };
};

// Helper method: Update service cost (for technician dashboard)
bookingSchema.methods.updateServiceCost = function (serviceIndex, newCost, technicianId, diagnosisNotes, reason) {
  if (!this.isMultiService || !this.services || !this.services[serviceIndex]) {
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
  if (!this.isMultiService || !this.services) {
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
  if (!this.isMultiService || !this.services || this.services.length === 0) {
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
    unitType: svc.airconTypeName || svc.name || 'Unknown',
    brand: svc.brand || '',
    model: '',
    applianceType: svc.applianceType || svc.airconType || '',
    applianceTypeName: svc.airconTypeName || '',
    hp: svc.hp || null,
    hpDescription: svc.hpDescription || '',
    problemDescription: svc.repairIssue || '',
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

  // snapshot customer information if we have an id but no details yet
  // ALWAYS fetch real customer data from database
  if (this.customerId) {
    console.log('🔍 BookingService pre-save: Fetching REAL customer data from database...');
    try {
      const User = mongoose.model("User");
      const u = await User.findById(this.customerId);

      if (u) {
        // Manually construct full name from firstName and lastName
        const firstName = u.firstName || '';
        const lastName = u.lastName || '';
        const constructedName = `${firstName} ${lastName}`.trim();

        this.customer = {
          _id: u._id,
          name: constructedName || "Customer Name",
          email: u.email || "customer@example.com",
          phone: u.phone || u.mobile || "09123456789",
          address: u.address || "Default Address",
        };
        console.log('✅ REAL customer data fetched:', {
          name: this.customer.name,
          email: this.customer.email
        });
      } else {
        console.log('❌ Customer not found in database for ID:', this.customerId);
      }
    } catch (e) {
      console.error('❌ Error fetching customer:', e.message);
    }
  }
  // snapshot chosen service info if we have a reference and no snapshot yet
  if (this.serviceId && (!this.service || !this.service._id)) {
    try {
      // serviceModel should already be set (pre-save earlier)
      const Model = mongoose.model(this.serviceModel || "CoreService");
      const svc = await Model.findById(this.serviceId).lean();
      if (svc) {
        this.service = {
          _id: svc._id,
          name: svc.name || svc.title || "",
          description: svc.description || svc.commonFaults || "",
          basePrice: svc.basePrice || svc.laborPerHour || 0,
        };
        // also cache price and (approx) duration
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
      this.estimatedFee = (this.totalPrice || 0); // totalPrice already includes travelFare
    } else {
      const base = this.servicePrice || (this.service && this.service.basePrice) || 0;
      this.estimatedFee = base + (this.travelFare || 0);
    }
  }
  // ALWAYS fetch real technician data from database
  if (this.technicianId) {
    console.log('🔍 BookingService pre-save: Fetching REAL technician data from database...');
    try {
      const Technician = mongoose.model("Technician");
      const tech = await Technician.findById(this.technicianId);

      if (tech) {
        this.technician = {
          _id: tech._id,
          name: tech.name || "Technician Name",
          // Use userEmail field (correct field in Technician model)
          email: tech.userEmail || tech.email || "technician@example.com",
          phone: tech.phone || tech.mobile || "0987654321",
        };
        console.log('✅ REAL technician data fetched:', {
          name: this.technician.name,
          email: this.technician.email
        });
      } else {
        console.log('❌ Technician not found in database for ID:', this.technicianId);
      }
    } catch (e) {
      console.error('❌ Error fetching technician:', e.message);
    }
  }

  // Auto-calculate total costs for multi-service bookings
  if (this.isMultiService && this.services && this.services.length > 0) {
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
bookingSchema.index({ bookingReference: 1 }); // For quick reference lookup
bookingSchema.index({ workOrderNumber: 1 }); // For work order lookup
bookingSchema.index({ serviceModel: 1, status: 1 }); // For repair queue queries
bookingSchema.index({ 'services.type': 1, 'services.costUpdatedByTechnician': 1 }); // For repair workflow queries
bookingSchema.index({ priority: 1, status: 1 }); // For priority-based repair queue
bookingSchema.index({ 'slaTracking.responseTarget': 1, 'slaTracking.responseBreached': 1 }); // For SLA monitoring
bookingSchema.index({ 'slaTracking.resolutionTarget': 1, 'slaTracking.resolutionBreached': 1 }); // For resolution SLA
bookingSchema.index({ 'technicianAssistant.repairComplexity': 1 }); // For complexity-based queries
bookingSchema.index({ createdAt: -1 }); // For recent repairs listing

module.exports = mongoose.model("BookingService", bookingSchema);
