(function (global) {
  "use strict";

  var dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var dayOrder = [1, 2, 3, 4, 5, 6, 0];

  function timeLabel(minutes) {
    var hour = Math.floor(minutes / 60);
    var minute = minutes % 60;
    return (hour % 12 || 12) + ":" + String(minute).padStart(2, "0") + " " + (hour >= 12 && hour < 24 ? "PM" : "AM");
  }

  function format(hours) {
    var byDay = new Map((Array.isArray(hours) ? hours : []).map(function (row) {
      return [Number(row.dayOfWeek), row];
    }));
    var groups = [];
    dayOrder.forEach(function (day) {
      var row = byDay.get(day);
      var start = Number(row && row.startMinutes);
      var end = Number(row && row.endMinutes);
      if (!row || !row.open || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      var previous = groups[groups.length - 1];
      if (previous && previous.last === dayOrder[dayOrder.indexOf(day) - 1] && previous.start === start && previous.end === end) {
        previous.last = day;
      } else {
        groups.push({ first: day, last: day, start: start, end: end });
      }
    });
    if (!groups.length) return "No store pickup hours are available right now.";
    return groups.map(function (group) {
      var days = dayNames[group.first] + (group.last === group.first ? "" : "–" + dayNames[group.last]);
      return days + " · " + timeLabel(group.start) + "–" + timeLabel(group.end);
    }).join("; ");
  }

  async function load() {
    var response = await fetch("/api/public/company/store-open-hours", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("Store hours are unavailable");
    var data = await response.json();
    return data.hours || [];
  }

  global.CustomerStoreHours = { format: format, load: load };
})(window);
