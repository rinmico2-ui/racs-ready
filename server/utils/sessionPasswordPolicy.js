"use strict";

// A revoked JWT must not regain access through its older server session.
function isSessionCurrent(session, user) {
  if (!user || !session || !session.userId) return false;
  if (!user.lastPasswordChange) return true;
  const changedAt = new Date(user.lastPasswordChange).getTime();
  const createdAt = new Date(session.createdAt).getTime();
  return Number.isFinite(createdAt) && Number.isFinite(changedAt) && createdAt >= changedAt;
}

module.exports = { isSessionCurrent };
