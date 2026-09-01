const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    target: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true },

    // ── Enterprise audit classification (filterable/categorizable) ─────────
    category: { type: String, default: 'system', index: true }, // booking|order|payment|assignment|project|expense|auth|inventory|settings|system
    entityType: { type: String, default: '' }, // BookingService|Order|WalkInSale|Payment|Assignment|Project|Expense|Technician|User
    entityId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actionType: { type: String, default: 'action' }, // created|updated|status_change|cancelled|deleted|auth|action
    module: { type: String, default: '' },
    actorRole: { type: String, default: '' },
    actorName: { type: String, default: '' },

    // Security and operational context. These fields are intentionally
    // denormalized so incident reviews never depend on mutable user records.
    outcome: {
      type: String,
      enum: ['success', 'failure', 'pending', 'blocked', 'unknown'],
      default: 'success',
      index: true,
    },
    riskLevel: {
      type: String,
      enum: ['info', 'low', 'medium', 'high', 'critical'],
      default: 'info',
      index: true,
    },
    source: {
      type: String,
      enum: ['authenticated_user', 'unauthenticated_request', 'system', 'integration'],
      default: 'system',
    },
    requestId: { type: String, default: '', index: true },
    requestMethod: { type: String, default: '' },
    requestPath: { type: String, default: '' },
    userAgent: { type: String, default: '' },

    ip: String,
    details: mongoose.Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Query-optimized compound indexes
activityLogSchema.index({ category: 1, createdAt: -1 });
activityLogSchema.index({ entityType: 1, entityId: 1 });
activityLogSchema.index({ actionType: 1, createdAt: -1 });
activityLogSchema.index({ actor: 1, createdAt: -1 });
activityLogSchema.index({ riskLevel: 1, outcome: 1, createdAt: -1 });
activityLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
