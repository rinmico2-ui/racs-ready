/**
 * Add minutes to either a 24-hour ("13:30") or 12-hour ("1:30 PM") clock
 * value while preserving the caller's display format.
 */
function addMinutesToClock(value, minutes) {
  const match = /^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i.exec(String(value || "").trim());
  if (!match) return "";

  const usesTwelveHourClock = Boolean(match[3]);
  let hours = Number(match[1]);
  const minuteValue = Number(match[2]);
  if (hours > 23 || minuteValue > 59 || (usesTwelveHourClock && (hours < 1 || hours > 12))) return "";

  if (usesTwelveHourClock) {
    hours %= 12;
    if (match[3].toUpperCase() === "PM") hours += 12;
  }

  const increment = Math.max(1, Number(minutes) || 60);
  const total = ((hours * 60 + minuteValue + increment) % 1440 + 1440) % 1440;
  const endHours = Math.floor(total / 60);
  const endMinutes = String(total % 60).padStart(2, "0");

  if (!usesTwelveHourClock) return `${String(endHours).padStart(2, "0")}:${endMinutes}`;
  const period = endHours >= 12 ? "PM" : "AM";
  return `${endHours % 12 || 12}:${endMinutes} ${period}`;
}

module.exports = { addMinutesToClock };
