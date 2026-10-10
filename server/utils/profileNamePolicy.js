"use strict";

const NAME_CHANGE_COOLDOWN_DAYS = 30;
const NAME_CHANGE_COOLDOWN_MS = NAME_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

function profileNamePolicy(user, now = new Date()) {
  const changedAt = user && user.profileNameChangedAt;
  const timestamp = changedAt ? new Date(changedAt).getTime() : NaN;
  const next = Number.isFinite(timestamp) ? timestamp + NAME_CHANGE_COOLDOWN_MS : null;
  return {
    cooldownDays: NAME_CHANGE_COOLDOWN_DAYS,
    canChangeName: next === null || new Date(now).getTime() >= next,
    nextNameChangeAt: next === null ? null : new Date(next).toISOString(),
  };
}

module.exports = { profileNamePolicy, NAME_CHANGE_COOLDOWN_MS };
