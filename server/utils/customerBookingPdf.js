'use strict';
const { PDFDocument } = require('pdfkit');
function bookingSummary(booking, payments = [], pricing = new Map()) {
  const finance = require('./enterpriseRevenue');
  const price = require('./revenueRecognition').bookingApprovedValue(booking, pricing);
  const ledger = finance.summarizePaymentLedger(payments);
  const hasLedger = payments.length > 0;
  const lines = booking.services?.length ? booking.services : [{ ...booking.service, quantity: booking.quantity || 1 }];
  return {
    reference: booking.bookingReference || booking.workOrderNumber || 'Booking', status: String(booking.status || 'pending').replace(/[-_]/g, ' '),
    customer: booking.customer?.name || 'Customer', address: booking.location?.address || booking.address || booking.customer?.address || '',
    date: booking.bookingDate, startTime: booking.startTime || '', endTime: booking.endTime || '', technician: booking.technician?.name || 'To be confirmed',
    services: lines.map(line => ({ name: line.name || 'Service', appliance: line.applianceTypeName || line.airconTypeName || line.applianceKind || '', brand: line.brand || '', quantity: Math.max(1, Number(line.quantity) || 1), status: String(line.status || '').replace(/[-_]/g,' ') })),
    approvedValue: price, paymentsReceived: hasLedger ? ledger.grossCollections : null, completedRefunds: hasLedger ? ledger.refunds : null,
    unpaidBalance: hasLedger ? finance.outstandingForValue(price, payments) : null,
    continuation: booking.continuation?.status === 'pending' ? 'The next visit is being arranged.' : booking.continuation?.scheduledDate ? `Next visit: ${require('./reportingDates').dateKey(booking.continuation.scheduledDate)} ${booking.continuation.startTime || ''} PHT` : '',
  };
}
async function buildCustomerBookingPdf(summary) {
  const doc = new PDFDocument({ size:'A4', margin:44, info:{ Title:'Booking Summary', Author:'CALIDRO RACS' } });
  const chunks = [], result = new Promise((resolve,reject) => { doc.on('data',chunk=>chunks.push(chunk)); doc.on('end',()=>resolve(Buffer.concat(chunks))); doc.on('error',reject); });
  const text = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').slice(0,1500);
  const date = value => value ? new Date(value).toLocaleDateString('en-PH',{timeZone:'Asia/Manila',year:'numeric',month:'long',day:'numeric'}) : 'To be confirmed';
  const amount = value => value == null ? 'No payment ledger record available' : 'PHP ' + Number(value).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
  function row(name,value) { if(doc.y>doc.page.height-100)doc.addPage();doc.font('Helvetica-Bold').fontSize(10).fillColor('#334155').text(text(name));doc.font('Helvetica').fillColor('#172033').text(text(value)).moveDown(0.7); }
  doc.font('Helvetica-Bold').fontSize(22).text('Booking Summary');doc.font('Helvetica').fontSize(10).text('CALIDRO RACS').moveDown();
  row('Reference',summary.reference);row('Status',summary.status);row('Customer',summary.customer);row('Service address',summary.address || 'To be confirmed');
  row('Scheduled visit',date(summary.date)+(summary.startTime?' | '+summary.startTime+(summary.endTime?' - '+summary.endTime:'')+' PHT':''));row('Technician',summary.technician);
  doc.font('Helvetica-Bold').fontSize(13).text('Added services').moveDown(0.7);
  summary.services.forEach(service=>row(service.name,`${service.quantity} appliance(s)${service.appliance?' | '+service.appliance:''}${service.brand?' | '+service.brand:''}${service.status?' | '+service.status:''}`));
  row('Approved booking value',amount(summary.approvedValue));row('Payments received',amount(summary.paymentsReceived));row('Completed refunds',amount(summary.completedRefunds));row('Unpaid balance',amount(summary.unpaidBalance));
  if(summary.continuation)row('Continuation',summary.continuation);
  doc.moveDown().font('Helvetica').fontSize(9).fillColor('#64748b').text('This is a booking summary, not an official receipt. Scheduling and approved charges may change.');
  doc.text('Generated '+new Date().toLocaleString('en-PH',{timeZone:'Asia/Manila'})+' PHT');doc.end();return result;
}
function createBookingPdfHandler({ Booking = require('../models/BookingService'), Payment = require('../models/Payment'), mongoose = require('mongoose'), pricing = require('./revenueRecognition').buildProjectPricingMap, render = buildCustomerBookingPdf } = {}) {
  return async (req,res,next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({error:'Invalid booking reference.'});
      const booking = await Booking.findOne({ _id:req.params.id, customerId:req.user._id, ...require('./reportingScope').reportableMatch() })
        .select('bookingReference workOrderNumber status serviceType serviceModel sourceOrderId isProject totalPrice estimatedFee initialCost totalFinalCost finalCost inspectionFeeAmount inspectionFeeDistanceFare inspectionFeeTotalCollected approval quotation.totalCost discount travelFare bookingDate startTime endTime quantity service.name services.name services.type services.quantity services.initialCost services.unitPrice services.totalPrice services.finalCost services.costUpdatedByTechnician services.approval services.quotation.totalCost services.status services.brand services.applianceTypeName services.airconTypeName customer.name customer.address address location.address technician.name continuation.status continuation.scheduledDate continuation.startTime')
        .lean();
      if(!booking)return res.status(404).json({error:'Booking not found.'});
      const projectPricing = await pricing([booking]);
      const projectId = projectPricing.get(String(booking._id))?.projectId;
      const payments = await Payment.find({ ...require('./reportingScope').reportableMatch(), $or: [{ bookingId:booking._id }, ...(projectId ? [{ projectId }] : [])] })
        .select('status amount method collectedAt verifiedAt completedAt submittedAt refundStatus refundAmount refundMethod refundedAt').lean();
      const buffer = await render(bookingSummary(booking,payments,projectPricing));
      res.set('Cache-Control','private, no-store');res.set('Content-Type','application/pdf');res.set('Content-Disposition','attachment; filename="booking-summary.pdf"');return res.send(buffer);
    }catch(error){next(error);}
  };
}
module.exports = { bookingSummary, buildCustomerBookingPdf, createBookingPdfHandler };
