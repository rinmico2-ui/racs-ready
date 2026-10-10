"use strict";

const Order = require("../models/Order");
const { manilaDateKey, parseAppointmentTime } = require("./bookingDateTime");

const ACTIVE_DELIVERY_STATUSES = [
  "pending_payment", "preparing_unit", "technician_assigned",
  "technician_accepted", "technician_declined", "out_for_delivery",
  "arrived", "installing",
];

function orderCapacityInterval(order, bufferMinutes = 0) {
  const timeParts = String(order?.timeSlot || "").split(/\s+-\s+/);
  const start = parseAppointmentTime(timeParts[0]);
  // Legacy active orders without a usable time must not silently leave the
  // day appearing free. They consume one conservative full-day capacity unit.
  if (!Number.isFinite(start)) return { startTime: 0, endTime: 1440 };
  const units = (order.items || []).reduce(
    (total, item) => total + Math.max(1, Number(item.quantity) || 1), 0,
  );
  const workMinutes = order.fulfillmentType === "delivery_installation"
    ? 60 * Math.max(1, units) : 60;
  const travelMinutes = Math.max(0, Number(order.routeDurationMin) || 30);
  const calculatedEnd = start + workMinutes + travelMinutes + Math.max(0, Number(bufferMinutes) || 0);
  const explicitEnd = timeParts.length > 1 ? parseAppointmentTime(timeParts[1]) : NaN;
  return {
    startTime: start,
    endTime: Number.isFinite(explicitEnd) && explicitEnd > start ? Math.max(calculatedEnd, explicitEnd) : calculatedEnd,
  };
}

function orderCapacityEndTime(order, bufferMinutes = 0) {
  const minutes = orderCapacityInterval(order, bufferMinutes).endTime;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function calendarKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value : manilaDateKey(value);
}

async function loadActiveOrderCapacityRows(startDate, endDate, {
  activeBookingIds = new Set(), activeLinkedOrderIds = new Set(),
  excludeOrderId = null, bufferMinutes = 0,
} = {}) {
  const firstKey = calendarKey(startDate);
  const lastKey = calendarKey(endDate);
  if (!firstKey || !lastKey || firstKey > lastKey) return [];

  // Include both UTC-midnight and Manila-midnight legacy date storage, then
  // filter by the actual Manila calendar date below.
  const queryStart = new Date(`${firstKey}T00:00:00.000Z`);
  queryStart.setUTCDate(queryStart.getUTCDate() - 1);
  const queryEnd = new Date(`${lastKey}T23:59:59.999Z`);
  queryEnd.setUTCDate(queryEnd.getUTCDate() + 1);
  const orders = await Order.find({
    isProject: { $ne: true },
    fulfillmentType: { $in: ["delivery_only", "delivery_installation"] },
    status: { $in: ACTIVE_DELIVERY_STATUSES },
    "delivery.preferredDate": { $gte: queryStart, $lte: queryEnd },
  }).select("_id bookingId technicianId fulfillmentType status delivery.preferredDate timeSlot items.quantity routeDurationMin").lean();

  const coveredBookingIds = new Set([...activeBookingIds].map(String));
  const coveredOrderIds = new Set([...activeLinkedOrderIds].map(String));
  return orders.flatMap(order => {
    const date = order.delivery?.preferredDate;
    const key = date && manilaDateKey(date);
    if (!key || key < firstKey || key > lastKey) return [];
    if (excludeOrderId && String(order._id) === String(excludeOrderId)) return [];
    if (coveredOrderIds.has(String(order._id))
      || (order.bookingId && coveredBookingIds.has(String(order.bookingId)))) return [];
    const interval = orderCapacityInterval(order, bufferMinutes);
    return [{
      _id: order._id,
      sourceOrderId: order._id,
      bookingDate: date,
      technicianId: order.technicianId || null,
      startTime: interval.startTime,
      endTime: interval.endTime,
    }];
  });
}

module.exports = { ACTIVE_DELIVERY_STATUSES, orderCapacityInterval, orderCapacityEndTime, loadActiveOrderCapacityRows };
