"use strict";

function extendAcceptanceDeadline(current, minutes, now = new Date()) {
  if ((typeof minutes !== "number" && typeof minutes !== "string") || String(minutes).trim() === "" || !Number.isInteger(Number(minutes)) || Number(minutes) < 5 || Number(minutes) > 720) {
    throw Object.assign(new Error("Enter a whole number of minutes from 5 to 720."), { status: 400 });
  }
  const base = Math.max(new Date(current || now).getTime() || 0, now.getTime());
  return new Date(base + Number(minutes) * 60000);
}

module.exports = { extendAcceptanceDeadline };
