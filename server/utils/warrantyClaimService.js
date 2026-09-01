const WarrantyClaim = require("../models/WarrantyClaim");

async function reconcileWarrantySource(claim) {
  if (!claim?.sourceId || !["booking", "order"].includes(claim.sourceType)) return;
  const otherActive = await WarrantyClaim.exists({
    sourceType: claim.sourceType,
    sourceId: claim.sourceId,
    active: true,
    _id: { $ne: claim._id },
  });
  if (otherActive) return;
  const Model = claim.sourceType === "booking"
    ? require("../models/BookingService")
    : require("../models/Order");
  const source = await Model.findById(claim.sourceId).select("warranty status");
  if (!source?.warranty) return;
  const endDates = [
    source.warranty.endDate,
    ...(source.warranty.coverages || []).map(coverage => coverage?.endDate),
  ].filter(Boolean).map(value => new Date(value)).filter(value => !Number.isNaN(value.getTime()));
  const active = endDates.some(endDate => endDate >= new Date());
  source.warranty.status = active ? "active" : "expired";
  if (claim.sourceType === "booking" && source.status === "warranty_claim") {
    source.status = active ? "under_warranty" : "closed";
  }
  await source.save();
}

module.exports = { reconcileWarrantySource };
