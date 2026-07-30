const mongoose = require("mongoose");

/**
 * Generic key/value store for site-wide configuration that admins can
 * change at runtime (e.g. fare per km, feature flags, etc.).
 */
const siteSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true, trim: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("SiteSetting", siteSettingSchema);
