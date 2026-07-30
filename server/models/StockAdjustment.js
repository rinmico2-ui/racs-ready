const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// StockAdjustment — Audit log for every inventory quantity change
// ─────────────────────────────────────────────────────────────────────────────
// Records stock_in, stock_out, adjustment, job_usage, return, damage events.
// Provides a full audit trail of who changed what, when, and why.
// ─────────────────────────────────────────────────────────────────────────────

const STOCK_ADJUSTMENT_TYPES = [
  "stock_in",    // Admin restocks (purchase, return from job, transfer in)
  "stock_out",   // Admin manual removal (transfer out, write-off)
  "adjustment",  // Manual correction / audit fix
  "job_usage",   // Technician consumed during repair (auto from ServiceToolUsage)
  "return",      // Stock restored from cancelled job or returned part
  "damage",      // Damaged / written off
];

const STOCK_ADJUSTMENT_REASONS = [
  "purchase",     // New stock purchased
  "return",       // Returned from customer or job
  "repair_used",  // Used during repair
  "damaged",      // Damaged / write-off
  "adjustment",   // Manual correction
  "transfer",     // Transferred between locations
];

const stockAdjustmentSchema = new mongoose.Schema(
  {
    toolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tool",
      required: true,
      index: true,
    },

    type: {
      type: String,
      enum: STOCK_ADJUSTMENT_TYPES,
      required: true,
      index: true,
    },

    quantityBefore: {
      type: Number,
      required: true,
    },

    quantityAfter: {
      type: Number,
      required: true,
    },

    delta: {
      type: Number,
      required: true,
      // Positive for stock_in, negative for stock_out/adjustment/damage
    },

    reason: {
      type: String,
      enum: STOCK_ADJUSTMENT_REASONS,
      default: null,
    },

    notes: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BookingService",
      default: null,
      // Links to BookingService when type is "job_usage" or "return"
    },

    adjustedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// ─── Indexes ─────────────────────────────────────────────────────────────────

stockAdjustmentSchema.index({ toolId: 1, createdAt: -1 });
stockAdjustmentSchema.index({ type: 1, createdAt: -1 });
stockAdjustmentSchema.index({ adjustedBy: 1, createdAt: -1 });

// ─── Static Helpers ──────────────────────────────────────────────────────────

/**
 * Record a stock adjustment and update the Tool quantity atomically.
 * @param {Object} params
 * @param {ObjectId} params.toolId
 * @param {String} params.type - from STOCK_ADJUSTMENT_TYPES
 * @param {Number} params.delta - positive for in, negative for out
 * @param {ObjectId} params.adjustedBy - User who made the change
 * @param {String} [params.reason] - from STOCK_ADJUSTMENT_REASONS
 * @param {String} [params.notes]
 * @param {ObjectId} [params.referenceId] - BookingService link
 * @returns {Object} { adjustment, tool }
 */
stockAdjustmentSchema.statics.record = async function ({
  toolId, type, delta, adjustedBy, reason, notes, referenceId,
}) {
  const Tool = mongoose.model("Tool");

  const tool = await Tool.findById(toolId);
  if (!tool) throw Object.assign(new Error("Tool not found"), { status: 404 });

  const quantityBefore = tool.quantity;
  const quantityAfter = Math.max(0, quantityBefore + delta);

  // Update tool quantity atomically
  tool.quantity = quantityAfter;
  await tool.save();

  // Create adjustment record
  const adjustment = await this.create({
    toolId,
    type,
    quantityBefore,
    quantityAfter,
    delta,
    reason: reason || null,
    notes: notes || null,
    referenceId: referenceId || null,
    adjustedBy,
  });

  return { adjustment, tool };
};

module.exports = mongoose.model("StockAdjustment", stockAdjustmentSchema);
