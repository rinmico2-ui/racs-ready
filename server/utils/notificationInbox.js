"use strict";

// Technician inboxes are personal. Admin/secretary inboxes also include the
// shared notices sent to their staff role. Every read and write uses this rule.
function notificationInboxFilter(userId, role) {
  if (!userId) throw new TypeError("A notification recipient is required.");
  if (role === "technician" || !role) return { userId };
  return { $or: [{ userId }, { userId: null, role }] };
}

module.exports = { notificationInboxFilter };
