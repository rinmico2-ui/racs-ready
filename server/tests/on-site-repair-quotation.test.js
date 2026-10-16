'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Booking = require('../models/BookingService');
const flow = require('../utils/repairUnitWorkflow');
const { buildRepairQuoteSuggestion } = require('../utils/repairQuoteSuggestion');
const fees = { minor: 300, standard: 500, complex: 800, major: 1500 };
const customerId = new mongoose.Types.ObjectId(), actorId = new mongoose.Types.ObjectId(), technicianId = new mongoose.Types.ObjectId(), toolId = new mongoose.Types.ObjectId();
function booking() {
  return new Booking({ customerId, serviceType: 'repair', status: 'inspection_in_progress', downpaymentAmount: 50, bookingDate: new Date('2026-10-19T00:00:00Z'),
    initialCost: 500, totalPrice: 500, amountPaid: 500, inspectionFeeCollected: true, repairUnitTracking: true,
    services: [{ type: 'repair', name: 'Aircon repair', quantity: 1, units: [{ unitIndex: 1, label: 'Aircon', problemDescription: 'The aircon is not cooling.' }] }] });
}
const input = extra => ({ findings: 'The capacitor is outside its rated range.', diagnosis: 'Faulty run capacitor', laborCategory: 'minor', parts: [{ toolId, quantity: 1, cost: 1 }], ...extra });
function quote(b, extra = {}) {
  flow.inspect(b, 'G1-U001', input(extra), { technicianId, laborFees: fees, catalog: [{ _id: toolId, itemName: 'Run Capacitor', sellingPrice: 500, costPrice: 200 }] });
  flow.submitInspection(b); b.inspection = { completedAt: new Date() };
  return b;
}
test('AI suggestions use company labor and saved part selling prices instead of AI-provided prices', () => {
  const suggestion = buildRepairQuoteSuggestion({ repairComplexity: 'high', laborCost: 999999,
    possibleParts: [{ name: 'Run Capacitor', quantity: 2, price: 1 }, { name: 'Unknown sensor', price: 75 }] }, [{ _id: toolId, itemName: 'Run Capacitor', sellingPrice: 500, costPrice: 200 }], fees);
  assert.equal(suggestion.laborCategory, 'complex'); assert.equal(suggestion.laborCost, 800);
  assert.equal(suggestion.parts[0].cost, 500); assert.equal(suggestion.parts[0].quantity, 2);
  assert.equal(suggestion.parts[1].cost, null); assert.equal(suggestion.parts[1].requiresPrice, true);
});
test('ambiguous catalog names require a confirmed manual price and duplicate suggestions do not duplicate parts', () => {
  const result = buildRepairQuoteSuggestion({ repairComplexity: 'specialist_required', possibleParts: ['Capacitor', 'capacitor', null, { name: {} }] },
    [{ _id: toolId, itemName: 'Capacitor', sellingPrice: 100 }, { _id: new mongoose.Types.ObjectId(), itemName: 'Capacitor', sellingPrice: 200 }], fees);
  assert.equal(result.laborCost, 1500); assert.equal(result.parts.length, 1); assert.equal(result.parts[0].toolId, null); assert.equal(result.parts[0].requiresPrice, true);
});
test('a technician custom labor price is validated, priced once, and retained by the actual booking schema', async () => {
  const b = quote(booking(), { laborPricingMode: 'custom', laborCost: 650, laborPriceReason: 'Includes additional wiring repair and load testing.', diagnosisSource: 'ai_reviewed' });
  const unit = b.services[0].units[0];
  assert.equal(unit.quotation.totalCost, 1150); assert.equal(unit.quotation.companyLaborCost, 300);
  assert.equal(unit.quotation.laborPricingMode, 'custom'); assert.match(unit.quotation.laborPriceReason, /wiring/); assert.equal(unit.diagnosis.source, 'ai_reviewed');
  await b.validate();
});
test('company pricing ignores forged labor and part totals and still computes a server-side quotation', () => {
  const b = quote(booking(), { laborCost: 1, totalCost: 1 });
  assert.equal(b.services[0].units[0].quotation.laborCost, 300); assert.equal(b.services[0].units[0].quotation.parts[0].cost, 500); assert.equal(b.quotationReview.totalAmount, 800);
});
test('custom labor rejects missing reasons, invalid amounts, structured prices and unsupported pricing modes', () => {
  for (const extra of [{ laborPricingMode: 'custom', laborCost: 100 }, { laborPricingMode: 'custom', laborCost: -1, laborPriceReason: 'Testing work' },
    { laborPricingMode: 'custom', laborCost: [], laborPriceReason: 'Testing work' }, { laborPricingMode: 'custom', laborCost: 1000001, laborPriceReason: 'Testing work' }, { laborPricingMode: 'unsafe' }]) {
    assert.throws(() => quote(booking(), extra), error => error.status === 400);
  }
});
test('on-site consent records the actual technician and customer decision without claiming an admin review', async () => {
  const b = quote(booking());
  flow.recordOnSiteDecision(b, { customerAgreed: true, confirmedQuotationTotal: 800 }, { technicianId, actorId });
  const unit = b.services[0].units[0];
  assert.equal(b.approval.status, 'approved'); assert.equal(b.approval.method, 'on_site'); assert.equal(b.quotation.totalCost, 800); assert.equal(b.balanceAmount, 800);
  assert.equal(String(unit.repairReview.recordedBy), String(actorId)); assert.equal(String(unit.repairReview.decidedBy), String(customerId));
  assert.equal(unit.repairReview.decisionMethod, 'on_site'); assert.equal(unit.repairReview.reviewedBy, undefined); assert.equal(b.amountPaid, 500);
  await b.validate();
});
test('on-site decisions require an explicit consent and the exact quotation shown to the customer', () => {
  for (const consent of [{ confirmedQuotationTotal: 800 }, { customerAgreed: true, confirmedQuotationTotal: 1 }, { customerAgreed: true, confirmedQuotationTotal: '800' }, { customerAgreed: true, confirmedQuotationTotal: NaN }]) {
    const b = quote(booking()); assert.throws(() => flow.recordOnSiteDecision(b, consent, { technicianId, actorId })); assert.equal(b.services[0].units[0].repairReview.state, 'staff_review');
  }
});
test('inspection text and unknown supplier prices reject structured or blank input', () => {
  for (const extra of [{ findings: {} }, { diagnosis: ['Faulty capacitor'] }, { parts: [{ name: 'Sensor', quantity: 1, cost: '' }] },
    { parts: [{ name: 'Sensor', quantity: 1, cost: null }] }, { parts: [{ name: {}, quantity: 1, cost: 500 }] }]) {
    assert.throws(() => quote(booking(), extra), error => error.status === 400);
  }
});
test('returned or incomplete quotations cannot be approved verbally until corrected and submitted again', () => {
  const b = booking(); assert.equal(flow.canDecideOnSite(b), false);
  quote(b); flow.review(b, 'reject', actorId, 'Verify the replacement part first.');
  assert.equal(flow.canDecideOnSite(b), false);
  assert.throws(() => flow.recordOnSiteDecision(b, { customerAgreed: true, confirmedQuotationTotal: 800 }, { technicianId, actorId }), /resubmitted/);
});
test('cancelling the repair keeps inspection money and records a reason without creating a refund', async () => {
  const b = quote(booking());
  flow.recordOnSiteDecision(b, { customerAgreed: true, confirmedQuotationTotal: 800, reason: 'Customer will replace the old appliance instead.' }, { technicianId, actorId, cancel: true });
  assert.equal(b.status, 'repair_declined'); assert.equal(b.services[0].units[0].repairReview.state, 'declined'); assert.equal(b.quotation.totalCost, 0); assert.equal(b.amountPaid, 500); assert.equal(b.balanceAmount, 0);
  assert.match(b.approval.reason, /replace/); await b.validate();
});
test('repairs already underway or with repair money collected need staff cancellation review', () => {
  for (const edit of [b => { b.repairExecution = { status: 'in_progress' }; }, b => { b.repairPaymentCollected = true; }]) {
    const b = quote(booking()); edit(b);
    assert.throws(() => flow.recordOnSiteDecision(b, { customerAgreed: true, confirmedQuotationTotal: 800, reason: 'Customer requested cancellation.' }, { technicianId, actorId, cancel: true }), /staff/);
  }
});
test('mixed quotations keep unpaid core service charges even after the inspection fee was collected', () => {
  const b = quote(booking()); b.serviceType = 'mixed'; b.totalPrice = 3500; b.amountPaid = 500;
  flow.recordOnSiteDecision(b, { customerAgreed: true, confirmedQuotationTotal: 800 }, { technicianId, actorId });
  assert.equal(b.balanceAmount, 3800);
});
test('the technician action bar exposes the on-site decision as soon as a quotation is submitted', () => {
  const fs = require('fs'), vm = require('vm'), path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../views/pages/technician/assignments.ejs'), 'utf8');
  const start = source.indexOf('function getWizardPageActionsForVisit('), end = source.indexOf('\n    function ', start + 20);
  const context = { isRepairAssignment: () => true, isMixedAssignment: () => false };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  for (const reviewStatus of ['pending', 'awaiting_customer', 'approved']) {
    const actions = context.getWizardPageActionsForVisit('overview', { status: 'in_progress', customerName: 'Fixture customer',
      bookingId: { _id: String(new mongoose.Types.ObjectId()), status: 'awaiting_approval', repairUnitTracking: true, quotationReview: { status: reviewStatus }, approval: { status: 'pending' } } });
    assert.match(actions, /Customer repair decision/); assert.match(actions, /openRepairWorkflow/);
    assert.match(actions, /View inspection and quotation/); assert.doesNotMatch(actions, /requirePhaseOneInspectionPayment/);
  }
});
