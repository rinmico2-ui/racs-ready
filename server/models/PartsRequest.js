const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// PartsRequest — Internal parts procurement request for out-of-stock items
// ─────────────────────────────────────────────────────────────────────────────
// When a repair requires parts that are out of stock, a PartsRequest is
// automatically created. The admin/inventory manager can then purchase or
// reserve the parts. Once received, the booking transitions to ready_for_repair.
// ─────────────────────────────────────────────────────────────────────────────

const PARTS_REQUEST_STATUSES = ["pending", "procuring", "received", "cancelled"];

const partsRequestSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      index: true,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BookingService",
      required: true,
      index: true,
    },
    serviceItemId: { type: mongoose.Schema.Types.ObjectId, index: true },

    workOrderNumber: {
      type: String,
      trim: true,
    },

    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },

    customerName: {
      type: String,
      trim: true,
    },

    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Technician",
    },

    technicianName: {
      type: String,
      trim: true,
    },

    items: [
      {
        toolId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Tool",
        },
        itemName: {
          type: String,
          required: true,
          trim: true,
        },
        requestedQty: {
          type: Number,
          required: true,
          min: 1,
        },
        availableQty: {
          type: Number,
          default: 0,
        },
        unitPrice: {
          type: Number,
          default: 0,
        },
        status: {
          type: String,
          enum: ["waiting", "ordered", "received"],
          default: "waiting",
        },
        receivedAt: Date,
      },
    ],

    status: {
      type: String,
      enum: PARTS_REQUEST_STATUSES,
      default: "pending",
      index: true,
    },

    requestedAt: {
      type: Date,
      default: Date.now,
    },

    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    // Status to restore when procurement was requested during the inspection
    // preparation phase rather than after quotation approval.
    resumeStatus: { type: String, trim: true },

    procuringAt: Date,
    procuredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    completedAt: Date,
    completedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    notes: {
      type: String,
      trim: true,
    },
    requiredDate: Date,
    priority: { type: String, enum: ["low", "normal", "high", "urgent"], default: "normal" },
    affectedWorkOrderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder" }],
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ─────────────────────────────────────────────────────────────────

partsRequestSchema.index({ status: 1, requestedAt: -1 });
partsRequestSchema.index({ bookingId: 1, status: 1 });
partsRequestSchema.index({ bookingId: 1, serviceItemId: 1, status: 1 });

// ─── Static Helpers ──────────────────────────────────────────────────────────

/**
 * Create a parts request from insufficient stock items.
 */
partsRequestSchema.statics.createFromInsufficientStock = async function ({
  bookingId,
  workOrderNumber,
  customerId,
  customerName,
  technicianId,
  technicianName,
  items,
  requestedBy,
}) {
  return this.create({
    bookingId,
    workOrderNumber,
    customerId,
    customerName,
    technicianId,
    technicianName,
    items: items.map((i) => ({
      toolId: i.toolId,
      itemName: i.itemName,
      requestedQty: i.requested,
      availableQty: i.available,
      status: "waiting",
    })),
    status: "pending",
    requestedAt: new Date(),
    requestedBy,
  });
};

/**
 * Mark parts request as procuring (admin started purchasing).
 */
partsRequestSchema.statics.startProcurement = async function (requestId, userId) {
  return this.findByIdAndUpdate(
    requestId,
    {
      status: "procuring",
      procuringAt: new Date(),
      procuredBy: userId,
    },
    { returnDocument: "after" }
  );
};

/**
 * Mark a specific item as received.
 */
partsRequestSchema.statics.receiveItem = async function (requestId, toolId) {
  const request = await this.findById(requestId);
  if (!request) return null;

  if (!toolId) {
    // Mark the first unreceived item that has no toolId (procurement of a new/custom part)
    const item = request.items.find((i) => !i.toolId && i.status !== "received");
    if (item) {
      item.status = "received";
      item.receivedAt = new Date();
    }
  } else {
    const item = request.items.find(
      (i) => i.toolId && i.toolId.toString() === toolId.toString()
    );
    if (item) {
      item.status = "received";
      item.receivedAt = new Date();
    }
  }

  // Check if all items are received
  const allReceived = request.items.every((i) => i.status === "received");
  if (allReceived) {
    request.status = "received";
    request.completedAt = new Date();
  }

  await request.save();
  return request;
};

module.exports = mongoose.model("PartsRequest", partsRequestSchema);
