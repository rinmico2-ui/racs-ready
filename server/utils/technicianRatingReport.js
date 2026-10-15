'use strict';
const { buildCanonicalReviews } = require('./serviceRatingReport');
const dates = require('./reportingDates');
const { reportableMatch, isReportable } = require('./reportingScope');
const { bookingCompletionDate, orderCompletionDate } = require('./enterpriseRevenue');
const COMPLETED = ['completed','repair_completed','closed'];
const ref = value => String(value?._id || value || '');
function buildTechnicianRatingReport({ technicians = [], bookings = [], orders = [], ratingDocs = [], now = new Date() } = {}) {
  const crew = technicians.filter(isReportable), known = new Set(crew.map(tech => ref(tech._id)));
  const services = bookings.filter(row => isReportable(row) && !row.sourceOrderId && COMPLETED.includes(row.status) && known.has(ref(row.technicianId)));
  const purchases = orders.filter(row => isReportable(row) && row.status === 'completed' && known.has(ref(row.technicianId)));
  const normalize = rows => rows.map(row => ({ ...row, technicianId: { _id: ref(row.technicianId), name: crew.find(tech => ref(tech._id) === ref(row.technicianId))?.name } }));
  const reviews = [
    ...buildCanonicalReviews({ bookings: normalize(services), ratingDocs: ratingDocs.filter(row => row.targetType === 'booking') }).map(row => ({ ...row, workType: 'booking' })),
    ...buildCanonicalReviews({ bookings: normalize(purchases), ratingDocs: ratingDocs.filter(row => row.targetType === 'order') }).map(row => ({ ...row, workType: 'order' })),
  ];
  const mean = rows => rows.length ? Number((rows.reduce((sum, row) => sum + row.rating, 0) / rows.length).toFixed(1)) : 0;
  const jobCounts = new Map();
  [...services, ...purchases].forEach(row => jobCounts.set(ref(row.technicianId), (jobCounts.get(ref(row.technicianId)) || 0) + 1));
  const rows = crew.map(tech => {
    const items = reviews.filter(row => row.technicianId === ref(tech._id)).sort((a,b) => new Date(b.date) - new Date(a.date));
    return { id: ref(tech._id), name: tech.name || 'Technician', email: tech.userEmail || '', department: '', avgRating: mean(items), reviewCount: items.length,
      jobsCompleted: jobCounts.get(ref(tech._id)) || 0, experience: tech.createdAt ? Math.max(0, Math.floor((now - new Date(tech.createdAt)) / (365.25 * dates.DAY))) : 0,
      status: tech.active !== false ? tech.availabilityStatus || 'Offline' : 'inactive', avatar: null,
      recentReviews: items.slice(0,5).map(item => ({ customer: item.customer, rating: item.rating, comment: item.comment, date: item.date })) };
  }).filter(row => row.reviewCount > 0).sort((a,b) => b.avgRating - a.avgRating || b.reviewCount - a.reviewCount || a.name.localeCompare(b.name));
  const ratingDistribution = { '5':0, '4':0, '3':0, '2':0, '1':0 };
  reviews.forEach(row => ratingDistribution[String(Math.round(row.rating))]++);
  const labels = [], avgRatings = [], jobCountsTrend = [], reviewCounts = [];
  for (let offset = -5; offset <= 0; offset++) {
    const start = dates.startOfMonth(now, offset), end = dates.startOfMonth(now, offset + 1);
    const monthReviews = reviews.filter(row => new Date(row.date) >= start && new Date(row.date) < end);
    labels.push(start.toLocaleDateString('en-PH', { month: 'short', timeZone: dates.TIME_ZONE })); avgRatings.push(mean(monthReviews)); reviewCounts.push(monthReviews.length);
    jobCountsTrend.push([...services.map(bookingCompletionDate), ...purchases.map(orderCompletionDate)].filter(value => { const date = new Date(value); return value && date >= start && date < end; }).length);
  }
  return { stats: { totalTechnicians: rows.length, avgRating: mean(reviews), totalReviews: reviews.length, topPerformers: rows.filter(row => row.avgRating >= 4.5).length }, technicians: rows,
    ratingDistribution, performanceTrends: { labels, avgRatings, jobCounts: jobCountsTrend, reviewCounts },
    dataQuality: { legacyTechnicianReviewsExcluded: ratingDocs.filter(row => row.targetType === 'technician' && row.moderationStatus !== 'hidden').length } };
}
async function loadTechnicianRatingReport({ technicianId } = {}) {
  const Technician = require('../models/Technician'), Booking = require('../models/BookingService'), Order = require('../models/Order'), Rating = require('../models/Rating');
  const fields = '_id status sourceOrderId bookingReference orderReference technicianId customerId customer customerRating customerRatingComment customerRatedAt createdAt updatedAt completedAt repairCompletion.completedAt slaTracking.resolutionAt';
  const [technicians, bookings, orders] = await Promise.all([
    Technician.find({ ...reportableMatch(), ...(technicianId ? { _id: technicianId } : {}) }).select('name userEmail active availabilityStatus createdAt').sort({ name: 1 }).lean(),
    Booking.find({ ...reportableMatch(), sourceOrderId: null, status: { $in: COMPLETED }, technicianId: technicianId || { $ne: null } }).select(fields).populate('customerId','firstName lastName name').lean(),
    Order.find({ ...reportableMatch(), status: 'completed', technicianId: technicianId || { $ne: null } }).select(fields + ' userId').populate('userId','firstName lastName name').lean(),
  ]);
  const ratingDocs = await Rating.find({ $or: [
    { targetType: 'booking', targetId: { $in: bookings.map(row => row._id) } },
    { targetType: 'order', targetId: { $in: orders.map(row => row._id) } },
    { targetType: 'technician', targetId: { $in: technicians.map(row => row._id) } },
  ] }).select('targetId targetType score comment moderationStatus customerId createdAt updatedAt').populate('customerId','firstName lastName name').lean();
  return buildTechnicianRatingReport({ technicians, bookings, orders: orders.map(order => ({ ...order, customerId: order.userId, serviceType: 'order' })), ratingDocs });
}
function filterTechnicianRows(rows, query = {}) {
  return rows.filter(row => {
    if (query.department && row.department && row.department !== query.department) return false;
    if (query.rating && (Number(query.rating) === 2 ? row.avgRating >= 3 : row.avgRating < Number(query.rating))) return false;
    const allowed = { active: ['active','available'], 'on-leave': ['on-leave','unavailable'], inactive: ['inactive','offline'] };
    if (allowed[query.status] && !allowed[query.status].includes(String(row.status).toLowerCase())) return false;
    if (query.experience === 'junior' && row.experience >= 2 || query.experience === 'mid' && (row.experience < 2 || row.experience >= 5) || query.experience === 'senior' && row.experience < 5) return false;
    return true;
  }).sort((a,b) => query.sort === 'name' ? a.name.localeCompare(b.name) : query.sort === 'reviews' ? b.reviewCount - a.reviewCount : query.sort === 'experience' ? b.experience - a.experience : b.avgRating - a.avgRating);
}
module.exports = { buildTechnicianRatingReport, loadTechnicianRatingReport, filterTechnicianRows };
