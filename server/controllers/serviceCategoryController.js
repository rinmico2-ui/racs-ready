const mongoose = require("mongoose");
const ServiceCategory = require("../models/ServiceCategory");
const { normalizeLifecycleReason, archiveRecord, restoreRecord } = require("../utils/dataLifecycle");

const ICON_COLORS = new Set(["blue", "amber", "violet", "green", "red", "cyan"]);

function text(value, max = 120) {
  return String(value || "").trim().slice(0, max);
}

function normalizedUnitTypes(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map((unit) => ({
    value: text(unit?.value, 100),
    label: text(unit?.label, 100),
    icon: text(unit?.icon, 60) || "bi-circle",
  })).filter((unit) => unit.value && unit.label);
}

function categoryPayload(body = {}, partial = false) {
  const payload = {};
  const assign = (key, value) => {
    if (!partial || Object.prototype.hasOwnProperty.call(body, key)) payload[key] = value;
  };
  assign("name", text(body.name));
  assign("slug", text(body.slug, 80).toLowerCase());
  assign("icon", text(body.icon, 60) || "bi-grid");
  assign("iconColor", ICON_COLORS.has(body.iconColor) ? body.iconColor : "blue");
  assign("unitTypes", normalizedUnitTypes(body.unitTypes));
  assign("isCustom", body.isCustom === true);
  if (!partial || Object.prototype.hasOwnProperty.call(body, "active")) payload.active = body.active !== false;
  if (Object.prototype.hasOwnProperty.call(body, "order")) payload.order = Number(body.order) || 0;
  return payload;
}

function sendError(res, error) {
  if (error?.code === 11000) {
    return res.status(409).json({ success: false, error: "Category name or slug already exists." });
  }
  return res.status(500).json({ success: false, error: "Unable to save the service category." });
}

exports.list = async (_req, res) => {
  try {
    const categories = await ServiceCategory.find({}).sort({ order: 1, name: 1 }).lean();
    return res.json({ success: true, categories });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    return sendError(res, error);
  }
};

exports.create = async (req, res) => {
  try {
    const payload = categoryPayload(req.body);
    if (!payload.name || !payload.slug) return res.status(400).json({ success: false, error: "Name and slug are required." });
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.slug)) return res.status(400).json({ success: false, error: "Slug may contain lowercase letters, numbers, and single hyphens only." });
    const exists = await ServiceCategory.findOne({ $or: [{ name: payload.name }, { slug: payload.slug }] }).lean();
    if (exists) return res.status(409).json({ success: false, error: "Category name or slug already exists." });
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, "order")) {
      const last = await ServiceCategory.findOne().sort({ order: -1 }).select("order").lean();
      payload.order = (Number(last?.order) || 0) + 1;
    }
    const category = await ServiceCategory.create(payload);
    return res.status(201).json({ success: true, category });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    return sendError(res, error);
  }
};

exports.update = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid category." });
    const payload = categoryPayload(req.body, true);
    if (Object.prototype.hasOwnProperty.call(payload, "name") && !payload.name) return res.status(400).json({ success: false, error: "Name is required." });
    if (Object.prototype.hasOwnProperty.call(payload, "slug") && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.slug)) return res.status(400).json({ success: false, error: "Enter a valid lowercase slug." });
    const category = await ServiceCategory.findById(req.params.id);
    if (!category) return res.status(404).json({ success: false, error: "Category not found." });
    const requestedActive = Object.prototype.hasOwnProperty.call(payload, "active") ? payload.active : undefined;
    delete payload.active;
    Object.assign(category, payload);
    if (requestedActive === false && category.active !== false) {
      const reason = normalizeLifecycleReason(req.body?.archiveReason, "Archive", { fallback: "Deactivated from the service catalogue by an administrator" });
      archiveRecord(category, req.user._id, reason);
    } else if (requestedActive === true && (category.active === false || category.archivedAt)) {
      const reason = normalizeLifecycleReason(req.body?.restoreReason, "Restore", { fallback: "Restored to the service catalogue by an administrator" });
      restoreRecord(category, req.user._id, reason);
    }
    await category.save();
    return res.json({ success: true, category });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    return sendError(res, error);
  }
};

exports.deactivate = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid category." });
    const category = await ServiceCategory.findById(req.params.id);
    if (!category) return res.status(404).json({ success: false, error: "Category not found." });
    if (category.isCustom) return res.status(400).json({ success: false, error: "The custom category cannot be deactivated here." });
    const reason = normalizeLifecycleReason(req.body?.reason, "Archive", { fallback: "Deactivated from the service catalogue by an administrator" });
    archiveRecord(category, req.user._id, reason);
    await category.save();
    return res.json({ success: true, message: "Category archived.", category });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    return sendError(res, error);
  }
};

exports.restore = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid category." });
    const category = await ServiceCategory.findById(req.params.id);
    if (!category) return res.status(404).json({ success: false, error: "Category not found." });
    const reason = normalizeLifecycleReason(req.body?.reason, "Restore", { fallback: "Restored to the service catalogue by an administrator" });
    restoreRecord(category, req.user._id, reason);
    await category.save();
    return res.json({ success: true, message: "Category restored.", category });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    return sendError(res, error);
  }
};

exports.reorder = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid category." });
    const category = await ServiceCategory.findByIdAndUpdate(req.params.id, { order: Number(req.body?.order) || 0 }, { returnDocument: "after", runValidators: true });
    if (!category) return res.status(404).json({ success: false, error: "Category not found." });
    return res.json({ success: true, category });
  } catch (error) {
    return sendError(res, error);
  }
};
