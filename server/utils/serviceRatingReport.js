const mongoose = require("mongoose");

const ALLOWED_RANGES = new Set(["today", "7", "30", "90", "365", "mtd", "qtd", "ytd", "all", "custom"]);
const ALLOWED_SORTS = new Set(["newest", "oldest", "highest", "lowest"]);
const ALLOWED_ATTENTION = new Set(["requires_attention", "monitor", "positive"]);
const ALLOWED_COMMENT = new Set(["with_comment", "without_comment"]);

function scalar(value, maxLength = 100) {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.trim().slice(0, maxLength) : "";
}

function validDateInput(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

function localDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseServiceRatingFilters(source = {}, now = new Date()) {
  const rangeInput = scalar(source.range, 10);
  const range = ALLOWED_RANGES.has(rangeInput) ? rangeInput : "30";
  let start = new Date(now);
  let end = new Date(now);
  end.setHours(23, 59, 59, 999);

  if (range === "all") start = null;
  else if (range === "custom" && validDateInput(scalar(source.from, 10))) {
    start = new Date(`${scalar(source.from, 10)}T00:00:00`);
    if (validDateInput(scalar(source.to, 10))) end = new Date(`${scalar(source.to, 10)}T23:59:59.999`);
  } else if (range === "mtd") start = new Date(now.getFullYear(), now.getMonth(), 1);
  else if (range === "qtd") start = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  else if (range === "ytd") start = new Date(now.getFullYear(), 0, 1);
  else if (range === "today") start.setHours(0, 0, 0, 0);
  else start.setDate(start.getDate() - (Number(range === "custom" ? 30 : range) - 1));

  if (start) {
    start.setHours(0, 0, 0, 0);
    if (start > end) [start, end] = [new Date(end.setHours(0, 0, 0, 0)), new Date(start.setHours(23, 59, 59, 999))];
    if (end - start > 5 * 365 * 86400000) {
      start = new Date(end);
      start.setFullYear(start.getFullYear() - 5);
      start.setHours(0, 0, 0, 0);
    }
  }

  let previousStart = null;
  let previousEnd = null;
  if (start) {
    const periodMs = Math.max(1, end.getTime() - start.getTime());
    previousEnd = new Date(start.getTime() - 1);
    previousStart = new Date(previousEnd.getTime() - periodMs);
  }

  const scoreInput = Number(scalar(source.rating, 2));
  const technicianInput = scalar(source.technician, 40);
  const filters = {
    range,
    from: scalar(source.from, 10),
    to: scalar(source.to, 10),
    start,
    end,
    previousStart,
    previousEnd,
    q: scalar(source.q, 80),
    rating: Number.isInteger(scoreInput) && scoreInput >= 1 && scoreInput <= 5 ? scoreInput : null,
    service: scalar(source.service, 120),
    serviceClass: ["core", "repair", "mixed", "unknown"].includes(scalar(source.serviceClass, 10)) ? scalar(source.serviceClass, 10) : "",
    technician: technicianInput === "unassigned" || mongoose.isValidObjectId(technicianInput) ? technicianInput : "",
    comment: ALLOWED_COMMENT.has(scalar(source.comment, 20)) ? scalar(source.comment, 20) : "",
    attention: ALLOWED_ATTENTION.has(scalar(source.attention, 30)) ? scalar(source.attention, 30) : "",
    sort: ALLOWED_SORTS.has(scalar(source.sort, 10)) ? scalar(source.sort, 10) : "newest",
    page: Math.max(1, Math.min(100000, Number.parseInt(scalar(source.page, 8), 10) || 1)),
    perPage: [10, 25, 50, 100].includes(Number(source.perPage)) ? Number(source.perPage) : 25,
  };
  filters.activeCount = [filters.q, filters.rating, filters.service, filters.serviceClass, filters.technician, filters.comment, filters.attention]
    .filter(value => value !== "" && value !== null).length;
  return filters;
}

function customerName(customer, snapshot) {
  if (customer) {
    const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ").trim();
    if (name) return name;
    if (customer.name) return customer.name;
  }
  return snapshot?.name || "Customer";
}

function serviceName(booking) {
  const names = [...new Set((booking?.services || []).map(service => service?.name).filter(Boolean))];
  return names.join(", ") || booking?.service?.name || booking?.serviceModel || booking?.serviceType || "Unspecified service";
}

function canonicalReview({ rating, booking, source }) {
  const score = Number(rating?.score ?? booking?.customerRating);
  if (!Number.isFinite(score) || score < 1 || score > 5) return null;
  const customer = rating?.customerId && typeof rating.customerId === "object" ? rating.customerId : null;
  const technician = booking?.technicianId && typeof booking.technicianId === "object" ? booking.technicianId : null;
  const comment = String(rating?.comment ?? booking?.customerRatingComment ?? "").trim();
  const reviewDate = rating?.createdAt || rating?.updatedAt || booking?.updatedAt || booking?.completedAt || booking?.createdAt;
  const bookingId = String(rating?.targetId || booking?._id || "");
  return {
    id: rating?._id ? `rating:${rating._id}` : `booking:${bookingId}`,
    ratingId: rating?._id ? String(rating._id) : "",
    bookingId,
    reference: booking?.bookingReference || booking?.workOrderNumber || (bookingId ? `#${bookingId.slice(-8).toUpperCase()}` : "—"),
    date: reviewDate,
    customer: customerName(customer, booking?.customer),
    email: customer?.email || booking?.customer?.email || "",
    serviceType: booking?.serviceType || "unknown",
    serviceName: serviceName(booking),
    technicianId: String(technician?._id || booking?.technicianId || booking?.technician?._id || ""),
    technician: technician?.name || booking?.technician?.name || "Unassigned",
    rating: score,
    comment,
    hasComment: Boolean(comment),
    attention: score <= 2 ? "requires_attention" : score === 3 ? "monitor" : "positive",
    source,
  };
}

function buildCanonicalReviews({ bookings = [], ratingDocs = [] } = {}) {
  const bookingById = new Map(bookings.map(booking => [String(booking._id), booking]));
  const normalizedByBooking = new Map();
  ratingDocs.forEach(rating => {
    const bookingId = String(rating.targetId || "");
    if (!bookingId) return;
    const existing = normalizedByBooking.get(bookingId);
    const candidateValid = Number.isFinite(Number(rating.score));
    const existingValid = existing && Number.isFinite(Number(existing.score));
    const candidateDate = new Date(rating.updatedAt || rating.createdAt || 0).getTime();
    const existingDate = existing ? new Date(existing.updatedAt || existing.createdAt || 0).getTime() : -1;
    if (!existing || (candidateValid && !existingValid) || (candidateValid === existingValid && candidateDate > existingDate)) {
      normalizedByBooking.set(bookingId, rating);
    }
  });
  const normalizedBookingIds = new Set(normalizedByBooking.keys());
  const normalized = [...normalizedByBooking.values()].map(rating => canonicalReview({
    rating,
    booking: bookingById.get(String(rating.targetId || "")),
    source: "normalized",
  })).filter(Boolean);
  const legacy = bookings
    .filter(booking => booking.customerRating != null && !normalizedBookingIds.has(String(booking._id)))
    .map(booking => canonicalReview({ booking, source: "legacy" }))
    .filter(Boolean);
  return [...normalized, ...legacy];
}

function dateInRange(value, start, end) {
  const date = value ? new Date(value) : null;
  return Boolean(date && !Number.isNaN(date.getTime()) && (!start || date >= start) && (!end || date <= end));
}

function applyReviewFilters(rows, filters, dates = {}) {
  const start = Object.prototype.hasOwnProperty.call(dates, "start") ? dates.start : filters.start;
  const end = Object.prototype.hasOwnProperty.call(dates, "end") ? dates.end : filters.end;
  const search = filters.q.toLocaleLowerCase();
  const filtered = rows.filter(row => {
    if (!dateInRange(row.date, start, end)) return false;
    if (filters.rating && row.rating !== filters.rating) return false;
    if (filters.service && row.serviceName !== filters.service) return false;
    if (filters.serviceClass && row.serviceType !== filters.serviceClass) return false;
    if (filters.technician === "unassigned" && row.technicianId) return false;
    if (filters.technician && filters.technician !== "unassigned" && row.technicianId !== filters.technician) return false;
    if (filters.comment === "with_comment" && !row.hasComment) return false;
    if (filters.comment === "without_comment" && row.hasComment) return false;
    if (filters.attention && row.attention !== filters.attention) return false;
    if (search) {
      const haystack = [row.reference, row.customer, row.email, row.serviceName, row.technician, row.comment].join(" ").toLocaleLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
  const sorters = {
    newest: (a, b) => new Date(b.date) - new Date(a.date),
    oldest: (a, b) => new Date(a.date) - new Date(b.date),
    highest: (a, b) => b.rating - a.rating || new Date(b.date) - new Date(a.date),
    lowest: (a, b) => a.rating - b.rating || new Date(b.date) - new Date(a.date),
  };
  return filtered.sort(sorters[filters.sort] || sorters.newest);
}

function percentChange(current, previous) {
  if (previous > 0) return ((current - previous) / previous) * 100;
  return current > 0 ? 100 : 0;
}

function summarize(rows) {
  const totalReviews = rows.length;
  const overallRating = totalReviews ? rows.reduce((sum, row) => sum + row.rating, 0) / totalReviews : 0;
  const satisfied = rows.filter(row => row.rating >= 4).length;
  const fiveStarCount = rows.filter(row => row.rating === 5).length;
  const lowRatingCount = rows.filter(row => row.rating <= 2).length;
  const withComments = rows.filter(row => row.hasComment).length;
  return {
    totalReviews,
    overallRating,
    satisfactionRate: totalReviews ? (satisfied / totalReviews) * 100 : 0,
    fiveStarCount,
    fiveStarRate: totalReviews ? (fiveStarCount / totalReviews) * 100 : 0,
    lowRatingCount,
    attentionRate: totalReviews ? (lowRatingCount / totalReviews) * 100 : 0,
    commentRate: totalReviews ? (withComments / totalReviews) * 100 : 0,
  };
}

function breakdown(rows, key, labelKey = key) {
  const groups = new Map();
  rows.forEach(row => {
    const id = row[key] || "Unspecified";
    const label = row[labelKey] || id;
    const group = groups.get(id) || { id, name: label, count: 0, total: 0, lowRatings: 0 };
    group.count += 1;
    group.total += row.rating;
    if (row.rating <= 2) group.lowRatings += 1;
    groups.set(id, group);
  });
  return [...groups.values()].map(group => ({
    id: group.id,
    name: group.name,
    count: group.count,
    rating: group.count ? group.total / group.count : 0,
    lowRatings: group.lowRatings,
  })).sort((a, b) => b.count - a.count || b.rating - a.rating);
}

function buildTrend(rows, start, end) {
  if (!end) return [];
  let trendStart = start ? new Date(start) : new Date(end.getFullYear(), end.getMonth() - 11, 1);
  const earliest = rows.reduce((min, row) => Math.min(min, new Date(row.date).getTime()), Infinity);
  if (!start && Number.isFinite(earliest) && earliest > trendStart.getTime()) trendStart = new Date(earliest);
  trendStart.setHours(0, 0, 0, 0);
  const days = Math.max(1, Math.floor((end - trendStart) / 86400000) + 1);
  const mode = days <= 31 ? "day" : days <= 120 ? "week" : "month";
  const buckets = [];
  let cursor = new Date(trendStart);
  if (mode === "month") cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  while (cursor <= end) {
    const bucketStart = new Date(cursor);
    let bucketEnd;
    if (mode === "day") {
      bucketEnd = new Date(cursor); bucketEnd.setHours(23, 59, 59, 999); cursor.setDate(cursor.getDate() + 1);
    } else if (mode === "week") {
      bucketEnd = new Date(cursor); bucketEnd.setDate(bucketEnd.getDate() + 6); bucketEnd.setHours(23, 59, 59, 999); cursor.setDate(cursor.getDate() + 7);
    } else {
      bucketEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59, 999);
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
    if (bucketEnd > end) bucketEnd = new Date(end);
    const matches = rows.filter(row => dateInRange(row.date, bucketStart, bucketEnd));
    buckets.push({
      label: mode === "month"
        ? bucketStart.toLocaleDateString("en-PH", { month: "short", year: "2-digit" })
        : bucketStart.toLocaleDateString("en-PH", { month: "short", day: "numeric" }),
      start: localDateKey(bucketStart),
      end: localDateKey(bucketEnd),
      count: matches.length,
      rating: summarize(matches).overallRating,
      satisfactionRate: summarize(matches).satisfactionRate,
    });
  }
  return buckets;
}

function buildAnalytics(currentRows, previousRows, filters) {
  const stats = summarize(currentRows);
  const previous = summarize(previousRows);
  const starBreakdown = { "5": 0, "4": 0, "3": 0, "2": 0, "1": 0 };
  currentRows.forEach(row => { starBreakdown[String(Math.round(row.rating))] += 1; });
  const services = breakdown(currentRows, "serviceName");
  const technicians = breakdown(currentRows.filter(row => row.technicianId), "technicianId", "technician");
  const comparisonAvailable = Boolean(filters.previousStart && previous.totalReviews > 0);
  const changes = comparisonAvailable ? {
    overallRating: stats.overallRating - previous.overallRating,
    satisfactionRate: stats.satisfactionRate - previous.satisfactionRate,
    fiveStarCount: percentChange(stats.fiveStarCount, previous.fiveStarCount),
    totalReviews: percentChange(stats.totalReviews, previous.totalReviews),
  } : { overallRating: 0, satisfactionRate: 0, fiveStarCount: 0, totalReviews: 0 };
  const insights = [];
  if (stats.lowRatingCount) insights.push({ tone: "danger", icon: "bi-exclamation-triangle", title: "Service recovery needed", text: `${stats.lowRatingCount} review${stats.lowRatingCount === 1 ? "" : "s"} rated the service 1–2 stars in this period.` });
  const weakest = services.filter(service => service.count >= 2).sort((a, b) => a.rating - b.rating)[0];
  if (weakest && weakest.rating < 4) insights.push({ tone: "warning", icon: "bi-tools", title: "Quality variance", text: `${weakest.name} averages ${weakest.rating.toFixed(1)} across ${weakest.count} reviews.` });
  if (changes.overallRating < -0.2) insights.push({ tone: "danger", icon: "bi-graph-down-arrow", title: "Rating decline", text: `Average rating is ${Math.abs(changes.overallRating).toFixed(2)} stars below the preceding period.` });
  if (stats.commentRate < 40 && stats.totalReviews) insights.push({ tone: "info", icon: "bi-chat-left-text", title: "Limited review context", text: `Only ${stats.commentRate.toFixed(0)}% of reviews include written feedback.` });
  if (!insights.length) insights.push({ tone: "success", icon: "bi-check2-circle", title: "Healthy customer sentiment", text: "No material low-rating concentration or negative period movement is visible." });
  return {
    stats,
    previous,
    comparisonAvailable,
    changes,
    starBreakdown,
    services,
    technicians,
    trend: buildTrend(currentRows, filters.start, filters.end),
    insights: insights.slice(0, 4),
  };
}

function publicFilters(filters) {
  return {
    range: filters.range, from: filters.from, to: filters.to, q: filters.q, rating: filters.rating,
    service: filters.service, serviceClass: filters.serviceClass, technician: filters.technician,
    comment: filters.comment, attention: filters.attention, sort: filters.sort, page: filters.page, perPage: filters.perPage,
  };
}

async function loadServiceRatingReport(source = {}, options = {}) {
  const Rating = require("../models/Rating");
  const BookingService = require("../models/BookingService");
  const filters = parseServiceRatingFilters(source, options.now || new Date());
  const queryStart = filters.previousStart || filters.start;
  const queryEnd = filters.end;
  const ratingDateFilter = queryStart ? { createdAt: { $gte: queryStart, $lte: queryEnd } } : {};
  const bookingDateFilter = queryStart ? {
    $or: [
      { updatedAt: { $gte: queryStart, $lte: queryEnd } },
      { updatedAt: null, createdAt: { $gte: queryStart, $lte: queryEnd } },
    ],
  } : {};

  const [primaryRatings, legacyCandidates] = await Promise.all([
    Rating.find({ targetType: "booking", ...ratingDateFilter }).populate("customerId", "firstName lastName name email").lean(),
    BookingService.find({ customerRating: { $ne: null }, ...bookingDateFilter })
      .populate("customerId", "firstName lastName name email")
      .populate("technicianId", "name active")
      .lean(),
  ]);
  const legacyIds = legacyCandidates.map(booking => booking._id);
  const normalizedLegacyLinks = legacyIds.length
    ? await Rating.find({ targetType: "booking", targetId: { $in: legacyIds } }).select("targetId").lean()
    : [];
  const primaryBookingIds = [...new Set(primaryRatings.map(rating => String(rating.targetId || "")).filter(mongoose.isValidObjectId))];
  const enrichmentBookings = primaryBookingIds.length
    ? await BookingService.find({ _id: { $in: primaryBookingIds } })
      .populate("customerId", "firstName lastName name email")
      .populate("technicianId", "name active")
      .lean()
    : [];
  const bookingMap = new Map([...legacyCandidates, ...enrichmentBookings].map(booking => [String(booking._id), booking]));
  const reviews = buildCanonicalReviews({
    bookings: [...bookingMap.values()],
    ratingDocs: [...primaryRatings, ...normalizedLegacyLinks],
  });
  const currentRows = applyReviewFilters(reviews, filters);
  const previousRows = filters.previousStart
    ? applyReviewFilters(reviews, filters, { start: filters.previousStart, end: filters.previousEnd })
    : [];
  const dateOnlyRows = reviews.filter(row => dateInRange(row.date, filters.start, filters.end));
  const filterOptions = {
    services: [...new Set(dateOnlyRows.map(row => row.serviceName).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    technicians: [...new Map(dateOnlyRows.filter(row => row.technicianId).map(row => [row.technicianId, { id: row.technicianId, name: row.technician }])).values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
  const totalRows = currentRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / filters.perPage));
  const currentPage = Math.min(filters.page, totalPages);
  const rows = options.paginate === false
    ? currentRows
    : currentRows.slice((currentPage - 1) * filters.perPage, currentPage * filters.perPage);
  return {
    rows,
    allRows: currentRows,
    analytics: buildAnalytics(currentRows, previousRows, filters),
    filters: { ...publicFilters(filters), page: currentPage },
    filterOptions,
    pagination: { page: currentPage, perPage: filters.perPage, totalRows, totalPages },
    reportStart: filters.start ? localDateKey(filters.start) : "all",
    reportEnd: localDateKey(filters.end),
  };
}

module.exports = {
  applyReviewFilters,
  buildAnalytics,
  buildCanonicalReviews,
  loadServiceRatingReport,
  parseServiceRatingFilters,
  summarize,
};
