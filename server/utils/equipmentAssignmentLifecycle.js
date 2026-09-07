const EquipmentAssignment = require("../models/EquipmentAssignment");
const Tool = require("../models/Tool");
const { normalizeLifecycleReason } = require("./dataLifecycle");

async function releaseReservedEquipment({ filter, actorId, reason, moduleName = "equipment" }) {
  const releaseReason = normalizeLifecycleReason(reason, "Release", {
    fallback: `Released by ${moduleName} workflow`,
  });
  const candidates = await EquipmentAssignment.find({ ...filter, status: "reserved" });
  const released = [];

  for (const candidate of candidates) {
    const releasedAt = new Date();
    const assignment = await EquipmentAssignment.findOneAndUpdate(
      { _id: candidate._id, status: "reserved" },
      {
        $set: {
          status: "released",
          releasedAt,
          releasedBy: actorId || null,
          releaseReason,
          resolutionState: "resolved",
        },
      },
      { returnDocument: "after", runValidators: true },
    );
    if (!assignment) continue;

    if (assignment.equipmentId) {
      try {
        await Tool.findByIdAndUpdate(assignment.equipmentId, [{
          $set: {
            reservedQuantity: {
              $max: [0, { $subtract: [{ $ifNull: ["$reservedQuantity", 0] }, assignment.quantity || 1] }],
            },
          },
        }], { updatePipeline: true });
      } catch (error) {
        // Keep the reservation retryable if its inventory counter could not be
        // updated. The timestamp condition avoids undoing a later transition.
        await EquipmentAssignment.updateOne(
          { _id: assignment._id, status: "released", releasedAt },
          {
            $set: { status: "reserved", resolutionState: "open" },
            $unset: { releasedAt: 1, releasedBy: 1, releaseReason: 1 },
          },
        ).catch(() => {});
        throw error;
      }
    }
    released.push(assignment);
  }

  return { released, count: released.length, reason: releaseReason };
}

module.exports = { releaseReservedEquipment };
