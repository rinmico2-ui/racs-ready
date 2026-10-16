'use strict';
const Booking = require('../models/BookingService');
const Order = require('../models/Order');
const Project = require('../models/Project');

// Resolve historical installation/project links in memory. The original ledger
// is preserved; a collection must have one reporting source, even when both an
// order and its installation booking are linked to the same transaction.
async function resolvePaymentSources(payments = [], models = {}) {
  const BookingModel = models.BookingService || Booking;
  const OrderModel = models.Order || Order;
  const ProjectModel = models.Project || Project;
  const projectIds = [...new Set(payments.filter(row => !row.orderId && row.projectId).map(row => String(row.projectId)))];
  const projects = projectIds.length ? await ProjectModel.find({ _id: { $in: projectIds } }).select('bookingId').lean() : [];
  const projectMap = new Map(projects.map(row => [String(row._id), row]));
  const bookingIds = [...new Set(payments.filter(row => !row.orderId).map(row => row.bookingId || projectMap.get(String(row.projectId))?.bookingId).filter(Boolean).map(String))];
  if (!bookingIds.length) return payments;
  const [bookings, orders] = await Promise.all([
    BookingModel.find({ _id: { $in: bookingIds } }).select('sourceOrderId').lean(),
    OrderModel.find({ bookingId: { $in: bookingIds } }).select('bookingId').lean(),
  ]);
  const bookingMap = new Map(bookings.map(row => [String(row._id), row]));
  const orderMap = new Map(orders.map(row => [String(row.bookingId), row._id]));
  return payments.map(row => {
    if (row.orderId) return row;
    const bookingId = row.bookingId || projectMap.get(String(row.projectId))?.bookingId;
    const orderId = bookingMap.get(String(bookingId))?.sourceOrderId || orderMap.get(String(bookingId));
    return orderId ? { ...row, orderId } : bookingId && !row.bookingId ? { ...row, bookingId } : row;
  });
}
module.exports = { resolvePaymentSources };
