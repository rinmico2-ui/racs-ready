'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const mongoose=require('mongoose');
const Booking=require('../models/BookingService');
const {BookingStatus}=require('../models/BookingStatus');
const source=fs.readFileSync(require.resolve('../routes/appointmentManagement'),'utf8').replace(/\r\n/g,'\n');
const begin=source.indexOf("router.post('/:id/verify-payment'");
const start=source.indexOf('async (req, res) => {',begin),end=source.indexOf('\n});',start);

function booking() {
  return new Booking({customerId:new mongoose.Types.ObjectId(),bookingReference:'TEST-CASH',
    serviceId:new mongoose.Types.ObjectId(),serviceModel:'CoreService',serviceType:'core',
    customer:{name:'Fixture Customer',phone:'09123456789'},bookingDate:new Date('2035-01-02'),startTime:'08:00',
    services:[{name:'Cleaning',type:'core',quantity:1,unitPrice:1450,totalPrice:1450}],
    totalPrice:1450,estimatedFee:1450,paymentMethod:'cash_after_service',paymentChannel:'cash',
    downpaymentPercentage:0,downpaymentAmount:0,amountPaid:0,balanceAmount:1450,paymentStatus:'pending',status:'pending'});
}

test('the booking schema accepts zero advance payment only for the explicit cash plan',async()=>{
  const value=booking();await value.validate();
  value.downpaymentAmount=100;
  await assert.rejects(value.validate(),/cannot require an advance payment/);
  const legacy=booking();legacy.paymentMethod='cod';
  await assert.rejects(legacy.validate(),/Downpayment amount is required/);
});

test('admin approves the cash booking for assignment without recording or verifying money',async()=>{
  const value=booking();let saves=0;
  value.save=async()=>{saves++;return value;};
  const handler=vm.runInNewContext('('+source.slice(start,end+2)+')',{
    BookingService:{findById:async()=>value},BookingStatus,
    bookingReviewState:()=>({isReviewOverdue:false}),measureRequest:(_req,_name,work)=>work(),
    Payment:{findOneAndUpdate(){assert.fail('Booking approval must not create or verify a payment');}},
    console:{error(){}}, require,
  });
  const response={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  await handler({params:{id:String(value._id)},user:{_id:new mongoose.Types.ObjectId(),name:'Admin'},body:{}},response);
  assert.equal(response.statusCode,200,response.body?.error);assert.equal(saves,1);
  assert.equal(response.body.destination,'assignment_queue');assert.equal(response.body.paymentDeferred,true);
  assert.equal(value.status,'awaiting_assignment');assert.equal(value.paymentStatus,'pending');
  assert.equal(value.amountPaid,0);assert.equal(value.balanceAmount,1450);
  assert.equal(value.paymentVerifiedAt,undefined);assert.equal(value.paymentVerifiedBy,undefined);
  assert.equal(value.cashPaymentConfirmation.amountDue,1450);
  assert.equal(require('../utils/resolutionPaymentPolicy').state(value).required,false);
});

test('cash bookings remain fully unpaid without a pending receipt or a required project deposit',()=>{
  const value=booking().toObject();
  const {projectPaymentSummary}=require('../utils/projectPaymentReview');
  const summary=projectPaymentSummary({payment:{}},value,[]);
  assert.equal(summary.amountPaid,0);assert.equal(summary.balance,1450);
  assert.equal(summary.downpaymentRequired,0);assert.equal(summary.requiresVerification,false);
  assert.equal(require('../utils/resolutionCenter').resolutionPaymentNeedsReview(value),false);
});

test('cash booking emails distinguish money due after service from money actually collected',()=>{
  const {buildBookingPaymentEmailDetails}=require('../utils/mailer');
  const data={paymentMethod:'cash_after_service',paymentChannel:'cash',estimatedFee:1450,downpaymentAmount:0,balanceAmount:1450,paymentStatus:'pending'};
  const details=buildBookingPaymentEmailDetails(data);
  assert.equal(details.payLabel,'100% Cash After Service');assert.equal(details.downpaymentAmount,0);
  assert.equal(details.balanceAmount,1450);assert.match(details.amountRows,/Paid upfront/);
  assert.doesNotMatch(details.verificationLabel,/receipt verification/);
  assert.equal(buildBookingPaymentEmailDetails({...data,balanceAmount:0,paymentStatus:'waiting_for_remittance'}).verificationLabel,'Payment recorded');
});
