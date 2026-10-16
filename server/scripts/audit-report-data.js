'use strict';
// This command has no write mode. Automatic collection/index creation is disabled
// before loading models, and customer contact/evidence fields are not requested.
let stage = 'configuration';
async function main() {
  require('dotenv').config({quiet:true});
  const mongoose=require('mongoose');mongoose.set('autoIndex',false);mongoose.set('autoCreate',false);
  const dates=require('../utils/reportingDates');
  const args=Object.fromEntries(process.argv.slice(2).map(arg=>arg.replace(/^--/,'').split('=')));
  if(Object.keys(args).some(key=>!['from','to'].includes(key)))throw Error('Use only --from=YYYY-MM-DD and --to=YYYY-MM-DD. This command has no apply option.');
  const period=dates.period(args.from||args.to?{range:'custom',from:args.from,to:args.to}:{range:'mtd'});
  const {buildMongoConnectionUri,disableRetryableWritesForDirectConnection}=require('../utils/mongoConnection');
  if(!process.env.MONGODB_URI)throw Error('Database configuration is missing.');
  const connection=buildMongoConnectionUri(process.env.MONGODB_URI,{directHosts:process.env.MONGODB_DIRECT_HOSTS,replicaSet:process.env.MONGODB_REPLICA_SET,authSource:process.env.MONGODB_AUTH_SOURCE});
  try {
    stage = 'database_connection';
    await mongoose.connect(disableRetryableWritesForDirectConnection(connection.uri),{serverSelectionTimeoutMS:8000,maxPoolSize:2,autoIndex:false,autoCreate:false});
    // The application registers User at startup; the standalone audit must do
    // so as well before revenue analytics populates payroll employee records.
    require('../models/User');
    stage = 'read_only_record_scan';
    const models={Booking:require('../models/BookingService'),Order:require('../models/Order'),Payment:require('../models/Payment'),WalkInSale:require('../models/WalkInSale'),ProductRefund:require('../models/ProductRefund'),Inventory:require('../models/Inventory'),HVACProduct:require('../models/HVACProduct'),Tool:require('../models/Tool'),Rating:require('../models/Rating')};
    const read=async(model,fields)=>{
      // Raw collection reads cannot trigger save/update hooks or schema casting.
      const rows=await model.collection.find({}, {projection:fields,maxTimeMS:30000}).limit(50001).toArray();
      if(rows.length>50000)throw Error('Audit document limit reached. Ask the maintainer to run a database-side audit for this larger dataset. No changes made.');
      return rows;
    };
    const scope={archivedAt:1,testDataExcludedAt:1,status:1,createdAt:1,updatedAt:1,completedAt:1};
    const [bookings,orders,payments,posSales,productRefunds,inventory,products,tools,ratings]=await Promise.all([
      read(models.Booking,{...scope,sourceOrderId:1,isProject:1,serviceType:1,serviceModel:1,totalPrice:1,estimatedFee:1,workOrderNumber:1,'services.type':1,'services.quantity':1,'services.totalPrice':1,'services.unitPrice':1,'services.finalCost':1,'services.costUpdatedByTechnician':1,'services.initialCost':1,'services.approval.status':1,'services.quotation.totalCost':1,discount:1,initialCost:1,totalFinalCost:1,finalCost:1,inspectionFeeAmount:1,inspectionFeeDistanceFare:1,inspectionFeeTotalCollected:1,travelFare:1,approval:1,'quotation.totalCost':1,'repairCompletion.completedAt':1,'slaTracking.resolutionAt':1,'statusHistory.status':1,'statusHistory.toStatus':1,'statusHistory.timestamp':1,'statusHistory.changedAt':1}),
      read(models.Order,{...scope,total:1,bookingId:1,'items.quantity':1,'items.costPrice':1,'statusHistory.status':1,'statusHistory.timestamp':1}),
      read(models.Payment,{...scope,bookingId:1,projectId:1,orderId:1,amount:1,method:1,collectedAt:1,verifiedAt:1,submittedAt:1,refundAmount:1,refundStatus:1,refundMethod:1,refundedAt:1}),
      read(models.WalkInSale,{...scope,totalAmount:1,totalCost:1}),
      read(models.ProductRefund,{...scope,sourceType:1,sourceId:1,amount:1,method:1,processedAt:1}),
      read(models.Inventory,{...scope,active:1,quantity:1,reservedQuantity:1,minStockLevel:1}),
      read(models.HVACProduct,{...scope,active:1,'variants._id':1,'variants.active':1,'variants.status':1,'variants.quantity':1,'variants.reservedQuantity':1,'variants.minStockLevel':1}),
      read(models.Tool,{...scope,active:1,type:1,inventoryClass:1,quantity:1,reservedQuantity:1,minStockLevel:1,assignable:1,assetStatus:1,assetCondition:1}),
      read(models.Rating,{targetType:1,targetId:1,score:1,moderationStatus:1}),
    ]);
    stage = 'project_pricing';
    const projectPricing=await require('../utils/revenueRecognition').buildProjectPricingMap(bookings.filter(row=>row.isProject));
    const report=require('../utils/reportDataAudit').auditReportRecords({bookings,orders,payments,posSales,productRefunds,inventory,products,tools,ratings,projectPricing,startDate:period.start,endDate:period.end});
    stage = 'revenue_calculation';
    const live=await require('../utils/revenueAnalytics').buildRevenueAnalytics({from:dates.dateKey(period.start),to:dates.dateKey(period.end)});
    report.tabConsistency = live.analytics.consistency;
    const explanation=live.analytics.reconciliation;
    report.explanation=explanation ? {cashBreakdown:explanation.cashBreakdown,unmatchedPaymentRecordsInPeriod:explanation.unmatchedPaymentRecords,unmatchedCollectionsInPeriod:explanation.unmatchedCollections,requestedWorkValue:explanation.requestedValue,paymentsAppliedToRequestedWork:explanation.appliedPayments,unpaidOnRequestedWork:explanation.unpaidBalance,paidStatusMismatchCount:explanation.paidStatusMismatchCount} : null;
    report.reconciliation={completedSalesDifference:Math.round((live.analytics.recognizedRevenue-report.totals.completedSalesAfterPeriodRefunds)*100)/100,refundDifference:Math.round((live.analytics.refunds-report.totals.completedRefunds)*100)/100,netCollectionsDifference:Math.round((live.analytics.netCollections-report.totals.paymentsAfterRefunds)*100)/100};
    report.reconciliation.matches=Object.values(report.reconciliation).every(value=>value===0);
    const reviewKeys=['orphanBookingPayments','orphanOrderPayments','completedOrderLinesMissingSavedCost','stockRowsWithNegativeQuantity','stockRowsWithReservationsAboveOnHand','duplicateReviewTargets','orphanWorkReviews','reviewsOnUnfinishedWork'];
    report.dataQuality={requiresReview:reviewKeys.some(key=>report.findings[key]>0),findingsToReview:reviewKeys.filter(key=>report.findings[key]>0),scope:'Historical inspected records; explanation cash groups use the selected dates.'};
    report.notes.push('reconciliation.matches compares arithmetic only. Missing work references and other data-quality findings still need review even when the totals match.');
    console.log(JSON.stringify(report,null,2));
  }finally{await mongoose.disconnect();}
}
if(require.main===module)main().catch(error=>{
  // Connection errors may contain credentials/hostnames. Never print raw errors.
  const safe=/^(Use only|Choose valid|Reporting date|Database configuration|Audit document)/.test(error.message)?error.message:'The read-only audit could not finish. Check database access and server logs without sharing credentials.';
  const knownNames = new Set(['MissingSchemaError', 'MongoServerSelectionError', 'MongoNetworkError', 'CastError', 'ValidationError', 'ReferenceError', 'TypeError']);
  console.error(JSON.stringify({mode:'read-only',completed:false,stage,errorType:knownNames.has(error.name)?error.name:'Error',error:safe}));process.exitCode=1;
});
module.exports={main};
