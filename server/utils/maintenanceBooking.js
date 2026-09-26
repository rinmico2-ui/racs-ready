function manilaDateKey(value) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function firstMaintenanceSlot(fromDateKey, durationMinutes, travelMinutes, getTimeSlots, maxDays = 30) {
  const start = new Date(`${fromDateKey}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || typeof getTimeSlots !== "function") return null;
  for (let offset = 0; offset < maxDays; offset += 1) {
    const date = new Date(start.getTime() + offset * 86400000).toISOString().slice(0, 10);
    const result = await getTimeSlots({
      date, duration: String(durationMinutes), quantity: "1", travelTime: String(travelMinutes),
    });
    const slot = result.statusCode < 400 && result.payload?.timeSlots?.find((item) => item.available === true);
    if (slot) return { date, startTime: slot.startTime };
  }
  return null;
}

module.exports = { manilaDateKey, firstMaintenanceSlot };
