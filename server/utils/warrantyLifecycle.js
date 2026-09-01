const DAY_MS = 24 * 60 * 60 * 1000;

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeWarrantyDays(value, fallback = 90) {
  const days = Number.parseInt(value, 10);
  return Number.isFinite(days) && days >= 1 && days <= 3650 ? days : fallback;
}

function buildWarrantyCoverage(completedAt, days = 90) {
  const startDate = validDate(completedAt) || new Date();
  const normalizedDays = normalizeWarrantyDays(days);
  return {
    days: normalizedDays,
    startDate,
    endDate: new Date(startDate.getTime() + normalizedDays * DAY_MS),
    status: "active",
  };
}

function resolveWarrantyCoverages(warranty, fallbackStart, now = new Date()) {
  const stored = Array.isArray(warranty?.coverages) ? warranty.coverages : [];
  if (!stored.length) {
    const legacy = resolveWarrantyCoverage(warranty, fallbackStart, now);
    return legacy ? [{ ...legacy, coverageId: "legacy", coverageType: "workmanship", serviceName: "Warranty coverage" }] : [];
  }
  return stored.map((coverage, index) => ({
    ...resolveWarrantyCoverage(coverage, warranty?.startDate || fallbackStart, now),
    coverageId: String(coverage.coverageId || `coverage:${index}`),
  }));
}

function resolveWarrantyCoverage(warranty, fallbackStart, now = new Date()) {
  if (!warranty) return null;

  const days = normalizeWarrantyDays(warranty.days);
  let startDate = validDate(warranty.startDate);
  let endDate = validDate(warranty.endDate);
  let datesInferred = false;

  if (!startDate && endDate) {
    startDate = new Date(endDate.getTime() - days * DAY_MS);
    datesInferred = true;
  }
  if (!startDate) {
    startDate = validDate(fallbackStart);
    datesInferred = Boolean(startDate);
  }
  if (!endDate && startDate) {
    endDate = new Date(startDate.getTime() + days * DAY_MS);
    datesInferred = true;
  }

  let status = warranty.status;
  if (status !== "claimed") {
    if (!startDate || !endDate) status = "incomplete";
    else status = endDate < validDate(now) ? "expired" : "active";
  }

  return {
    ...warranty,
    days,
    startDate,
    endDate,
    status,
    datesInferred,
  };
}

function bookingCompletionDate(booking, assignment) {
  const statusDate = [...(booking?.statusHistory || [])]
    .reverse()
    .find(entry => ["completed", "repair_completed", "under_warranty"].includes(entry.toStatus || entry.status))?.timestamp;
  const serviceDate = (booking?.services || [])
    .flatMap(service => service.statusHistory || [])
    .filter(entry => entry.status === "completed" && entry.changedAt)
    .sort((a, b) => new Date(b.changedAt) - new Date(a.changedAt))[0]?.changedAt;

  return validDate(booking?.completedAt)
    || validDate(booking?.repairCompletion?.completedAt)
    || validDate(assignment?.completedAt)
    || validDate(statusDate)
    || validDate(serviceDate);
}

module.exports = {
  DAY_MS,
  validDate,
  normalizeWarrantyDays,
  buildWarrantyCoverage,
  resolveWarrantyCoverage,
  resolveWarrantyCoverages,
  bookingCompletionDate,
};
