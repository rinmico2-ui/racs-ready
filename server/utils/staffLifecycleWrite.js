"use strict";

const { randomUUID } = require("node:crypto");
const { atomicWorkflowChanges } = require("./atomicWorkflowChanges");

async function writeStaffLifecycle(record, { action, actorId, reason, at = new Date() }) {
  if (!["archived", "restored"].includes(action)) throw new Error("Invalid staff lifecycle action");
  const archived = action === "archived";
  const changes = [record.user, record.technician].filter(Boolean).map(document => {
    const before = document.toObject({ depopulate: true, virtuals: false });
    const set = {
      active: !archived,
      archivedAt: archived ? at : null,
      archivedBy: archived ? actorId : null,
      archiveReason: archived ? reason : "",
      staffLifecycleHistory: [
        ...(before.staffLifecycleHistory || []),
        { action, at, by: actorId, reason },
      ],
    };
    if (document === record.user) set.currentSessionId = randomUUID();
    else set.availabilityStatus = "Offline";
    return {
      Model: document.constructor, before, set,
      guard: document === record.user
        ? { role: { $in: ["secretary", "technician"] } }
        : (before.user ? { user: before.user } : {}),
    };
  });

  // Update validators check the lifecycle fields, rather than requiring legacy
  // account/contact data to satisfy today's registration rules. The shared
  // writer guards versions and reverses a partial write on standalone MongoDB.
  let saved;
  try {
    saved = await atomicWorkflowChanges(changes);
  } catch (error) {
    if (error.status === 409) {
      error.message = "This staff record changed. Refresh the staff list before trying again.";
      error.code = "STAFF_CHANGED";
    } else if (error.status === 503) {
      error.message = "The staff update could not be safely completed. Ask an administrator to review it before retrying.";
      error.code = "STAFF_UPDATE_REQUIRES_REVIEW";
    }
    throw error;
  }
  let index = 0;
  return {
    ...record,
    user: record.user ? saved[index++] : null,
    technician: record.technician ? saved[index] : null,
  };
}

module.exports = { writeStaffLifecycle };
