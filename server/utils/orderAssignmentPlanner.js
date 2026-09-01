const BookingService = require('../models/BookingService');
const Order = require('../models/Order');
const Technician = require('../models/Technician');
const TechnicianSchedule = require('../models/TechnicianSchedule');
const LeaveRequest = require('../models/LeaveRequest');
const Assignment = require('../models/Assignment');

const ACTIVE_BOOKING_STATUSES = [
  'assigned', 'confirmed', 'scheduled', 'on-the-way', 'arrived', 'in-progress', 'ongoing',
  'inspection_scheduled', 'inspection_in_progress', 'repair_approved', 'ready_for_repair',
  'repair_scheduled', 'repair_in_progress',
];
const ACTIVE_ORDER_STATUSES = [
  'technician_assigned', 'technician_accepted', 'out_for_delivery', 'arrived', 'installing',
];

function minuteValue(value) {
  if (value == null || value === '') return NaN;
  const raw = String(value).trim().split(/\s+-\s+/)[0].trim();
  if (/^\d{1,4}$/.test(raw)) return Number(raw);
  const hm = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const ap = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!ap) return NaN;
  let hour = Number(ap[1]) % 12;
  if (ap[3].toUpperCase() === 'PM') hour += 12;
  return hour * 60 + Number(ap[2] || 0);
}

function explicitRangeEnd(value) {
  const parts = String(value || '').trim().split(/\s+-\s+/);
  return parts.length > 1 ? minuteValue(parts[1]) : NaN;
}

function dateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function orderWindow(order) {
  const start = minuteValue(order.timeSlot);
  const rangeEnd = explicitRangeEnd(order.timeSlot);
  const units = (order.items || []).reduce((sum, item) => sum + Math.max(1, Number(item.quantity) || 1), 0);
  const duration = order.fulfillmentType === 'delivery_installation'
    ? Math.max(120, units * 60)
    : Math.max(60, 60 + Math.max(0, units - 1) * 30);
  const end = Number.isFinite(rangeEnd) && rangeEnd > start ? rangeEnd : start + duration;
  return { start, end, duration: Math.max(duration, end - start) };
}

function bookingWindow(booking) {
  const start = minuteValue(booking.startTime);
  const explicitEnd = minuteValue(booking.endTime);
  const duration = Math.max(30, Number(booking.serviceDurationMinutes) || 60);
  const end = Number.isFinite(explicitEnd) && explicitEnd > start ? explicitEnd : start + duration;
  return { start, end, duration: Math.max(duration, end - start) };
}

function coordinates(entity) {
  const raw = entity?.delivery?.coordinates?.coordinates || entity?.location?.coordinates?.coordinates ||
    entity?.location?.coordinates || (entity?.location?.lat != null ? [entity.location.lng, entity.location.lat] : null);
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const lng = Number(raw[0]);
  const lat = Number(raw[1]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function distanceKm(a, b) {
  if (!a || !b) return null;
  const rad = number => number * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * 10) / 10;
}

function orderDate(order) {
  return order?.delivery?.preferredDate || null;
}

function technicianName(technician) {
  return `${technician.firstName || ''} ${technician.lastName || ''}`.trim() || technician.name || 'Technician';
}

async function buildOrderAssignmentPlan(orders, options = {}) {
  const rows = (orders || []).filter(Boolean).sort((a, b) =>
    new Date(orderDate(a)) - new Date(orderDate(b)) || minuteValue(a.timeSlot) - minuteValue(b.timeSlot));
  if (!rows.length) return [];

  const technicians = await Technician.find({ active: { $ne: false } })
    .select('_id user firstName lastName name phone email rating availabilityStatus location')
    .lean();
  const technicianIds = technicians.map(technician => technician._id);
  const timestamps = rows.map(order => new Date(orderDate(order)).getTime()).filter(Number.isFinite);
  if (!timestamps.length) return rows.map(order => ({
    orderId: String(order._id), orderReference: order.orderReference, customerName: order.customer?.name || 'Customer',
    fulfillmentType: order.fulfillmentType, scheduledDate: orderDate(order), timeSlot: order.timeSlot,
    recommended: null, candidates: [], issue: 'A valid delivery schedule is required',
  }));
  const minDate = new Date(Math.min(...timestamps)); minDate.setHours(0, 0, 0, 0);
  const maxDate = new Date(Math.max(...timestamps)); maxDate.setHours(23, 59, 59, 999);

  const [schedules, leaves, existingBookings, existingOrders, activeAssignments] = await Promise.all([
    TechnicianSchedule.find({ technicianId: { $in: technicianIds } }).lean(),
    LeaveRequest.find({ technicianId: { $in: technicianIds }, status: 'approved', startDate: { $lte: maxDate }, endDate: { $gte: minDate } }).lean(),
    BookingService.find({
      technicianId: { $in: technicianIds }, bookingDate: { $gte: minDate, $lte: maxDate },
      status: { $in: ACTIVE_BOOKING_STATUSES }, sourceOrderId: null,
    }).select('_id technicianId bookingDate startTime endTime serviceDurationMinutes').lean(),
    Order.find({
      technicianId: { $in: technicianIds }, 'delivery.preferredDate': { $gte: minDate, $lte: maxDate },
      status: { $in: ACTIVE_ORDER_STATUSES },
    }).select('_id technicianId delivery.preferredDate timeSlot fulfillmentType items').lean(),
    Assignment.find({ technicianId: { $in: technicianIds }, status: { $in: ['pending_acceptance', 'accepted', 'en_route', 'on_site', 'in_progress'] } })
      .select('technicianId').lean(),
  ]);

  const scheduleMap = new Map(schedules.map(schedule => [String(schedule.technicianId), schedule]));
  const activeLoad = new Map();
  activeAssignments.forEach(assignment => activeLoad.set(String(assignment.technicianId), (activeLoad.get(String(assignment.technicianId)) || 0) + 1));
  existingOrders.forEach(order => activeLoad.set(String(order.technicianId), (activeLoad.get(String(order.technicianId)) || 0) + 1));
  const allocations = new Map(technicianIds.map(id => [String(id), []]));
  existingBookings.forEach(booking => allocations.get(String(booking.technicianId))?.push({ ...bookingWindow(booking), date: dateKey(booking.bookingDate), planned: false }));
  existingOrders.forEach(order => allocations.get(String(order.technicianId))?.push({ ...orderWindow(order), date: dateKey(orderDate(order)), planned: false }));

  const plan = [];
  for (const order of rows) {
    const scheduledDate = orderDate(order);
    const key = dateKey(scheduledDate);
    const date = new Date(scheduledDate);
    const day = date.getDay();
    const target = orderWindow(order);
    const targetCoordinates = coordinates(order);
    const candidates = [];

    for (const technician of technicians) {
      const technicianId = String(technician._id);
      const schedule = scheduleMap.get(technicianId);
      const workingDay = schedule?.workingDays?.find(item => item.dayOfWeek === day);
      const restDay = schedule?.restDates?.some(item => dateKey(item?.date || item) === key);
      const nonWorkingDay = schedule?.nonWorkingWeekdays?.some(item => Number(item?.dayOfWeek ?? item) === day);
      const onLeave = leaves.some(leave => String(leave.technicianId) === technicianId &&
        date >= new Date(new Date(leave.startDate).setHours(0, 0, 0, 0)) &&
        date <= new Date(new Date(leave.endDate).setHours(23, 59, 59, 999)));
      if (!workingDay || restDay || nonWorkingDay || onLeave || !Number.isFinite(target.start)) continue;
      const workStart = Number(workingDay.startMinutes || 480);
      const workEnd = Number(workingDay.endMinutes || 1020);
      if (target.start < workStart || target.end > workEnd) continue;
      const dayJobs = (allocations.get(technicianId) || []).filter(allocation => allocation.date === key);
      if (dayJobs.some(allocation => target.start < allocation.end && target.end > allocation.start)) continue;
      const capacity = Math.max(1, workEnd - workStart);
      const usedMinutes = dayJobs.reduce((sum, allocation) => sum + (allocation.end - allocation.start), 0);
      if (usedMinutes + target.duration > capacity) continue;

      const distance = distanceKm(targetCoordinates, coordinates(technician));
      const openAssignments = activeLoad.get(technicianId) || 0;
      const utilization = usedMinutes / capacity;
      let score = 100 - dayJobs.length * 18 - openAssignments * 6 - utilization * 35 + (Number(technician.rating) || 0) * 4;
      if (key === dateKey(new Date()) && String(technician.availabilityStatus || '').toLowerCase() === 'available') score += 15;
      if (distance != null) score += Math.max(0, 35 - distance * 1.5);
      const reasons = ['Available during the delivery schedule', 'No booking or order conflict'];
      if (!dayJobs.length) reasons.push('No other scheduled work that day');
      else reasons.push(`${dayJobs.length} existing job${dayJobs.length === 1 ? '' : 's'} that day`);
      reasons.push(`${openAssignments} current open assignment${openAssignments === 1 ? '' : 's'}`);
      if (distance != null) reasons.push(`${distance} km from the customer`);
      reasons.push(`${Math.round(utilization * 100)}% of daily capacity used`);
      candidates.push({
        technicianId, name: technicianName(technician), score: Math.round(score), distanceKm: distance,
        currentWorkload: dayJobs.length, openAssignments, usedMinutes, capacityMinutes: capacity, reasons,
      });
    }

    candidates.sort((a, b) => b.score - a.score || a.currentWorkload - b.currentWorkload || (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999));
    const recommended = candidates[0] || null;
    if (recommended && options.reservePlan !== false) {
      allocations.get(recommended.technicianId).push({ ...target, date: key, orderId: String(order._id), planned: true });
    }
    plan.push({
      orderId: String(order._id),
      orderReference: order.orderReference || `#${String(order._id).slice(-8).toUpperCase()}`,
      customerName: order.customer?.name || 'Customer',
      fulfillmentType: order.fulfillmentType,
      scheduledDate,
      timeSlot: order.timeSlot,
      recommended,
      candidates: candidates.slice(0, 5),
    });
  }
  return plan;
}

module.exports = { buildOrderAssignmentPlan, minuteValue, orderWindow, dateKey };
