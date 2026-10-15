"use strict";

const { OrderCheckoutError, parseDateOnly } = require("./orderCheckoutPolicy");
const { manilaDateKey } = require("./bookingDateTime");

function validateInstallationWindow(input, preferredDate, now = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new OrderCheckoutError("Choose a preferred start date and finish-by date for this installation project.", 400, "ORDER_PROJECT_WINDOW_REQUIRED");
  }
  const start = parseDateOnly(input.preferredStartDate instanceof Date ? manilaDateKey(input.preferredStartDate) : input.preferredStartDate);
  const end = parseDateOnly(input.preferredCompletionDeadline instanceof Date ? manilaDateKey(input.preferredCompletionDeadline) : input.preferredCompletionDeadline);
  if (!start || !end || manilaDateKey(start) <= manilaDateKey(now) || end <= start ||
      end - start > 366 * 86400000 || (preferredDate && manilaDateKey(start) !== manilaDateKey(preferredDate))) {
    throw new OrderCheckoutError("Choose a future project start date and a later finish-by date within one year.", 400, "ORDER_PROJECT_WINDOW_INVALID");
  }
  return {
    preferredStartDate: new Date(`${manilaDateKey(start)}T00:00:00+08:00`),
    preferredCompletionDeadline: new Date(`${manilaDateKey(end)}T00:00:00+08:00`),
    preferredWorkingDays: [],
  };
}

async function installationWorkload(items, fulfillmentType) {
  const totalUnits = items.reduce((sum, item) => sum + Number(item.quantity), 0);
  const totalEstimatedMinutes = totalUnits * 60;
  const isProject = fulfillmentType === "delivery_installation" && await require("./enterpriseSchedulingEngine")
    .isLargeProject({ totalUnits, totalEstimatedMinutes });
  return { totalUnits, totalEstimatedMinutes, estimatedTotalHours: totalEstimatedMinutes / 60, isProject };
}

async function checkInstallationWindow(items, projectScheduling) {
  const workload = await installationWorkload(items, "delivery_installation");
  const preferences = validateInstallationWindow(projectScheduling);
  const verdict = await require("./enterpriseSchedulingEngine").getProjectWindowAvailability({
    startDate: manilaDateKey(preferences.preferredStartDate),
    endDate: manilaDateKey(preferences.preferredCompletionDeadline),
    requiredHours: workload.estimatedTotalHours, totalUnits: workload.totalUnits,
  });
  if (verdict.error) throw new OrderCheckoutError(verdict.error, 400, "ORDER_PROJECT_WINDOW_INVALID");
  return { ...verdict, ...workload, preferences };
}

function buildInstallationProject(order, user, ids) {
  const { orderSchedulingSource } = require("./orderResolutionScheduling");
  const { prepareProjectServiceChange } = require("./projectServiceChange");
  const source = orderSchedulingSource(order);
  source._id = ids.bookingId;
  source.customer = {
    _id: order.userId,
    name: order.customer?.name || user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim(),
    email: order.customer?.email || user.email || "",
    phone: order.delivery.contactNumber || user.phone || "",
  };
  source.location = { ...source.location,
    lat: order.delivery.coordinates?.coordinates?.[1], lng: order.delivery.coordinates?.coordinates?.[0] };
  source.services = source.services.map((line, index) => ({ ...line,
    applianceKind: "aircon", applianceGroupId: `order-${order._id}-${index}`, model: order.items[index].modelLine || "",
    unitPrice: 0, totalPrice: 0, brand: order.items[index].brand || "",
  }));
  const preferences = order.projectScheduling;
  const project = prepareProjectServiceChange(source, {
    startDate: preferences.preferredStartDate, endDate: preferences.preferredCompletionDeadline, inspectionDurationMinutes: 60,
  });
  // A preferred deadline is not a staff-confirmed completion date.
  delete project.plannedCompletionDate;
  const booking = {
    ...source, bookingDate: preferences.preferredStartDate, preferredDate: preferences.preferredStartDate,
    serviceDurationMinutes: source.quantity * 60, projectScheduling: preferences,
    paymentMethod: "other", paymentStatus: "pending", sourceOrderId: order._id,
    travelFare: 0, estimatedFee: 0, servicePrice: 0,
  };
  return { booking, project: { ...project, _id: ids.projectId, sourceOrderId: order._id,
    payment: { totalAmount: 0, amountPaid: 0, balanceAmount: 0, paymentStatus: "unpaid", paymentMethod: "other" } } };
}

module.exports = { validateInstallationWindow, installationWorkload, checkInstallationWindow, buildInstallationProject };
