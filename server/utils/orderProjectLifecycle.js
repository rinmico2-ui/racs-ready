"use strict";

const Order = require('../models/Order');
const Payment = require('../models/Payment');
const { summarizeBookingPayments } = require('./paymentSummary');

function fail(message, code = 'ORDER_PROJECT_NOT_READY') { return Object.assign(new Error(message), { status: 409, code }); }

async function loadProjectPurchase(project, session = null) {
  if (!project.sourceOrderId) return null;
  const query = Order.findById(project.sourceOrderId);
  if (session) query.session(session);
  const order = await query;
  if (!order || !order.isProject || String(order.projectId) !== String(project._id)) throw fail('The linked purchase could not be found. Ask Operations to review this project.');
  const paymentsQuery = Payment.find({ orderId: order._id });
  if (session) paymentsQuery.session(session);
  const payments = await paymentsQuery.lean();
  return { order, payments, ...purchasePaymentSummary(order, payments) };
}

function purchasePaymentSummary(order, payments) {
  const ledger = summarizeBookingPayments({}, payments);
  const total = Number(order.total) || 0;
  return {
    total, amountPaid: ledger.amountPaid, balance: Math.max(0, total - ledger.amountPaid),
    submittedAmount: ledger.submittedAmount,
    requiresVerification: payments.some(payment => payment.status === 'pending'),
    downpaymentRequired: Number(order.downpaymentAmount) || total,
    status: ledger.amountPaid >= total && total > 0 ? 'paid' : ledger.amountPaid > 0 ? 'partial' : 'pending',
  };
}

async function assertProjectPurchaseReady(project, { prepared = false, session = null } = {}) {
  const purchase = await loadProjectPurchase(project, session);
  if (!purchase) return null;
  const { order, payments } = purchase;
  if (['cancelled', 'completed'].includes(order.status)) throw fail('The purchase is cancelled or already complete. Refresh the project.');
  const verified = summarizeBookingPayments({}, payments.filter(payment => ['verified', 'paid', 'partial', 'remitted'].includes(payment.status))).amountPaid;
  if (!['paid', 'partial', 'verified', 'remitted', 'waiting_for_remittance'].includes(order.paymentStatus) || verified + .01 < purchase.downpaymentRequired) {
    throw fail('Verify the purchase payment in Aircon Orders before approving or starting this installation project.', 'ORDER_PAYMENT_NOT_VERIFIED');
  }
  if (prepared && order.preparation?.dispatch?.status !== 'ready') {
    throw fail('Confirm that all purchased aircons and included accessories are prepared in Aircon Orders before releasing the project.', 'ORDER_PREPARATION_REQUIRED');
  }
  return purchase;
}

async function recordProjectOrderStage(project, stage, session = null, serialNumbers = null) {
  const purchase = await loadProjectPurchase(project, session);
  if (!purchase) return;
  const { order } = purchase;
  if (order.status === 'cancelled') throw fail('This purchase was cancelled. Do not continue installation.');
  const statuses = { ready: 'technician_accepted', en_route: 'out_for_delivery', arrived: 'arrived', in_progress: 'installing', completed: 'completed' };
  const next = statuses[stage];
  if (!next || order.status === 'completed') return;
  const lead = (project.assignedTechnicians || []).find(member => String(member._id) === String(project.leadTechnicianId));
  if (lead) { order.technicianId = lead._id; order.technician = { _id: lead._id, name: lead.name || 'Project lead' }; }
  if (stage === 'ready') order.technicianAcceptance = { status: 'accepted', respondedAt: new Date() };
  if (next === 'completed') {
    if (purchase.balance > .01) throw fail('Collect the remaining purchase balance before completing the order.', 'ORDER_BALANCE_REQUIRED');
    const serials = validatePurchaseSerials(order, serialNumbers);
    await require('./productReturnPolicy').assertNoReturnSerialConflict(serials, session);
    let offset = 0;
    for (const item of order.items) { item.serialNumbers = serials.slice(offset, offset + item.quantity); offset += item.quantity; }
    order.completedAt = project.actualCompletionDate || new Date();
    order.balanceAmount = 0;
    order.paymentStatus = purchase.payments.some(payment => ['waiting_for_remittance', 'payment_collected', 'unaccounted', 'rejected'].includes(payment.status)) ? 'waiting_for_remittance' : 'paid';
    order.preparation.installation = { ...(order.preparation.installation?.toObject?.() || order.preparation.installation || {}), status: 'completed', blockers: [] };
    const { getAftercarePolicy, warrantyRuleForOrder } = require('./aftercarePolicy');
    // Use the same warranty snapshot as ordinary product installations.
    const rule = warrantyRuleForOrder(await getAftercarePolicy());
    const { buildOrderWarrantySnapshot } = require('./orderWarrantyPolicy');
    const warranty = buildOrderWarrantySnapshot(order, order.completedAt, rule);
    if (warranty) order.warranty = warranty;
  }
  if (order.status !== next) {
    order.status = next;
    order.statusHistory.push({ status: next, timestamp: new Date(), note: `Installation project ${stage.replace('_', ' ')}.` });
  }
  await order.save(session ? { session } : undefined);
  return order;
}

function validatePurchaseSerials(order, input) {
  const count = order.items.reduce((sum, item) => sum + Number(item.quantity), 0);
  if (!Array.isArray(input) || input.length !== count || input.some(serial => typeof serial !== 'string' || !serial.trim() || serial.trim().length > 120)) {
    throw fail(`Record one serial number for each of the ${count} purchased aircons.`, 'ORDER_SERIAL_NUMBERS_REQUIRED');
  }
  const serials = input.map(serial => serial.trim());
  if (new Set(serials.map(serial => serial.toLowerCase())).size !== count) throw fail('Each purchased aircon needs a unique serial number.', 'ORDER_SERIAL_NUMBERS_DUPLICATE');
  return serials;
}

async function syncCompletedPurchaseAftercare(project) {
  const purchase = await loadProjectPurchase(project);
  if (purchase?.order.status === 'completed') await require('./maintenanceLifecycle').syncMaintenanceFromOrder(purchase.order);
}

function emitPurchaseProjectUpdate(project, io, status) {
  if (!project.sourceOrderId || !io) return;
  const payload = { orderId: project.sourceOrderId, projectId: project._id, status, timestamp: Date.now() };
  io.to(`customer:${project.customerId}`).emit('order:status-change', payload);
  io.to('admin-room').emit('order:status-change', payload);
}

module.exports = { loadProjectPurchase, purchasePaymentSummary, assertProjectPurchaseReady,
  recordProjectOrderStage, validatePurchaseSerials, syncCompletedPurchaseAftercare, emitPurchaseProjectUpdate };
