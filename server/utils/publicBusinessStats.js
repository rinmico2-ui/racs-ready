const BookingService = require("../models/BookingService");
const Order = require("../models/Order");
const Rating = require("../models/Rating");
const Technician = require("../models/Technician");
const SiteSetting = require("../models/SiteSetting");

const CACHE_TTL_MS = 60 * 1000;
const COMPLETED_BOOKING_STATUSES = [
  "completed",
  "repair_completed",
  "under_warranty",
  "warranty_claim",
];

let cache = { value: null, expiresAt: 0 };

function validFoundedYear(value, currentYear = new Date().getFullYear()) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1900 && year <= currentYear ? year : null;
}

function completedYearsSince(year, currentYear = new Date().getFullYear()) {
  const normalized = validFoundedYear(year, currentYear);
  return normalized ? Math.max(0, currentYear - normalized) : 0;
}

function combineCustomerRatings({ ratings = [], bookingRatings = [], orderRatings = [] } = {}) {
  const scores = new Map();
  ratings.forEach((rating) => {
    const score = Number(rating.score);
    if (!Number.isFinite(score) || score < 1 || score > 5) return;
    const targetType = String(rating.targetType || "rating");
    const targetId = String(rating.targetId || rating._id || "");
    const key = ["booking", "order"].includes(targetType)
      ? `${targetType}:${targetId}`
      : `rating:${rating._id}`;
    scores.set(key, score);
  });
  bookingRatings.forEach((booking) => {
    const score = Number(booking.customerRating);
    if (Number.isFinite(score) && score >= 1 && score <= 5) scores.set(`booking:${booking._id}`, score);
  });
  orderRatings.forEach((order) => {
    const score = Number(order.customerRating);
    if (Number.isFinite(score) && score >= 1 && score <= 5) scores.set(`order:${order._id}`, score);
  });
  const values = [...scores.values()];
  const averageRating = values.length
    ? Math.round((values.reduce((sum, score) => sum + score, 0) / values.length) * 10) / 10
    : 0;
  const satisfiedCount = values.filter((score) => score >= 4).length;
  return {
    averageRating,
    ratingCount: values.length,
    satisfactionPercentage: values.length ? Math.round((satisfiedCount / values.length) * 100) : 0,
  };
}

async function oldestOperationalYear() {
  const [booking, order, technician] = await Promise.all([
    BookingService.findOne({}).sort({ createdAt: 1 }).select("createdAt").lean(),
    Order.findOne({}).sort({ createdAt: 1 }).select("createdAt").lean(),
    Technician.findOne({}).sort({ createdAt: 1 }).select("createdAt").lean(),
  ]);
  const years = [booking?.createdAt, order?.createdAt, technician?.createdAt]
    .map((date) => date && new Date(date).getFullYear())
    .filter((year) => Number.isInteger(year));
  return years.length ? Math.min(...years) : new Date().getFullYear();
}

async function getPublicBusinessStats({ bypassCache = false } = {}) {
  const now = Date.now();
  if (!bypassCache && cache.value && cache.expiresAt > now) return cache.value;

  const completionFilter = {
    $or: [
      { completedAt: { $type: "date" } },
      { status: { $in: COMPLETED_BOOKING_STATUSES } },
    ],
  };
  const [servicesCompleted, customersServedRows, activeTechnicians, ratingSummary, bookingRatingSummary, orderRatingSummary, foundedSetting] = await Promise.all([
    BookingService.countDocuments(completionFilter),
    BookingService.aggregate([
      { $match: { ...completionFilter, customerId: { $ne: null } } },
      { $group: { _id: "$customerId" } },
      { $count: "count" },
    ]),
    Technician.countDocuments({ active: { $ne: false } }),
    Rating.aggregate([
      { $match: { targetType: { $nin: ["booking", "order"] }, score: { $gte: 1, $lte: 5 } } },
      { $group: {
        _id: null,
        scoreTotal: { $sum: "$score" },
        count: { $sum: 1 },
        satisfiedCount: { $sum: { $cond: [{ $gte: ["$score", 4] }, 1, 0] } },
      } },
    ]),
    BookingService.aggregate([
      { $match: { customerRating: { $gte: 1, $lte: 5 } } },
      { $group: {
        _id: null,
        scoreTotal: { $sum: "$customerRating" },
        count: { $sum: 1 },
        satisfiedCount: { $sum: { $cond: [{ $gte: ["$customerRating", 4] }, 1, 0] } },
      } },
    ]),
    Order.aggregate([
      { $match: { customerRating: { $gte: 1, $lte: 5 } } },
      { $group: {
        _id: null,
        scoreTotal: { $sum: "$customerRating" },
        count: { $sum: 1 },
        satisfiedCount: { $sum: { $cond: [{ $gte: ["$customerRating", 4] }, 1, 0] } },
      } },
    ]),
    SiteSetting.findOne({ key: "companyFoundedYear" }).lean(),
  ]);

  const summaries = [ratingSummary[0], bookingRatingSummary[0], orderRatingSummary[0]].filter(Boolean);
  const ratingCount = summaries.reduce((sum, summary) => sum + Number(summary.count || 0), 0);
  const ratingTotal = summaries.reduce((sum, summary) => sum + Number(summary.scoreTotal || 0), 0);
  const satisfiedCount = summaries.reduce((sum, summary) => sum + Number(summary.satisfiedCount || 0), 0);
  const averageRating = ratingCount ? Math.round((ratingTotal / ratingCount) * 10) / 10 : 0;
  const customerRatings = {
    averageRating,
    ratingCount,
    satisfactionPercentage: ratingCount ? Math.round((satisfiedCount / ratingCount) * 100) : 0,
  };
  const configuredFoundedYear = validFoundedYear(foundedSetting?.value);
  const foundedYear = configuredFoundedYear || await oldestOperationalYear();
  const value = {
    servicesCompleted,
    customersServed: Number(customersServedRows[0]?.count || 0),
    activeTechnicians,
    ...customerRatings,
    foundedYear,
    yearsExperience: completedYearsSince(foundedYear),
    experienceSource: configuredFoundedYear ? "configured" : "oldest_record",
  };
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

function invalidatePublicBusinessStats() {
  cache = { value: null, expiresAt: 0 };
}

module.exports = {
  COMPLETED_BOOKING_STATUSES,
  validFoundedYear,
  completedYearsSince,
  combineCustomerRatings,
  getPublicBusinessStats,
  invalidatePublicBusinessStats,
};
