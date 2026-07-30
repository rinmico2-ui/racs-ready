const mongoose = require("mongoose");

/**
 * Role Model
 * -----------
 * Stores a named role (admin, secretary, technician, customer) together with
 * the set of permission keys it grants.  System roles (isSystem: true) cannot
 * be deleted — they are seeded once on first run.
 *
 * Permissions follow a flat `resource.action` naming convention.
 */

const roleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    label: { type: String, trim: true },
    description: { type: String, trim: true, default: "" },
    permissions: { type: [String], default: [] },
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Prevent accidental deletion of system roles
roleSchema.pre("deleteOne", { document: true, query: false }, function (next) {
  if (this.isSystem) {
    return next(new Error("Cannot delete a system role"));
  }
  next();
});

module.exports = mongoose.model("Role", roleSchema);
