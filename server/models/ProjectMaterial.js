const mongoose = require("mongoose");

const RESERVATION_STATUSES = ["reserved", "fulfilled", "cancelled"];
const MATERIAL_TYPES = ["part", "equipment", "tool"];

const projectMaterialSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Project",
    required: true,
    index: true,
  },

  workOrderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "WorkOrder",
    default: null,
  },

  // What kind of resource this is — drives the Admin (plan) vs Lead (assign) split.
  type: { type: String, enum: MATERIAL_TYPES, default: "equipment" },

  // How the item is used on the project:
  //   'shared'    — reserved at the PROJECT level; the whole team uses it. No
  //                 per-technician assignment required (pressure washer, ladder…).
  //   'assigned'  — exclusively assigned to ONE technician (limited quantity /
  //                 exclusive-use item, e.g. the single recovery machine).
  // Personal hand tools are never tracked. Consumables are always 'shared'.
  scope: { type: String, enum: ["shared", "assigned"], default: "shared" },

  itemName: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  unit: { type: String, default: "pcs" },
  unitPrice: { type: Number, default: 0 },
  totalPrice: { type: Number, default: 0 },

  status: {
    type: String,
    enum: RESERVATION_STATUSES,
    default: "reserved",
  },

  // Lead technician distributes shared equipment to individual technicians.
  assignedToTechnicianId: { type: mongoose.Schema.Types.ObjectId, ref: "Technician", default: null },
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  assignedAt: { type: Date, default: null },

  // Technician acknowledges receipt before leaving for site.
  pickedUp: { type: Boolean, default: false },
  pickedUpAt: { type: Date, default: null },
  pickedUpBy: { type: mongoose.Schema.Types.ObjectId, ref: "Technician", default: null },

  notes: { type: String, trim: true },

  reservedAt: { type: Date, default: Date.now },
  fulfilledAt: { type: Date },
  cancelledAt: { type: Date },

  source: { type: String, enum: ["inventory", "purchase", "other"], default: "inventory" },
  sourceId: { type: mongoose.Schema.Types.ObjectId },
});

projectMaterialSchema.pre("save", function () {
  this.totalPrice = (this.quantity || 0) * (this.unitPrice || 0);
});

projectMaterialSchema.statics.getProjectSummary = async function (projectId) {
  const pipeline = [
    { $match: { projectId: new mongoose.Types.ObjectId(projectId) } },
    {
      $group: {
        _id: "$status",
        totalItems: { $sum: 1 },
        totalQuantity: { $sum: "$quantity" },
        totalCost: { $sum: "$totalPrice" },
      },
    },
  ];
  return this.aggregate(pipeline);
};

module.exports = mongoose.model("ProjectMaterial", projectMaterialSchema);
