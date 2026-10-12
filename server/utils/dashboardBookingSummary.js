'use strict';

function dateFilter(start, end) {
  return {$or:[{bookingDate:{$gte:start,$lte:end}}, {createdAt:{$gte:start,$lte:end}}]};
}

function buildBookingSummaryPipeline(startOfDay, endOfDay, trendDays) {
  const today = {$or:[
    {$and:[{$gte:['$bookingDate',startOfDay]},{$lte:['$bookingDate',endOfDay]}]},
    {$and:[{$gte:['$createdAt',startOfDay]},{$lte:['$createdAt',endOfDay]}]},
  ]};
  const facets = {
    totals:[{$group:{_id:null,totalBookingsAllTime:{$sum:1},
      totalBookingsToday:{$sum:{$cond:[today,1,0]}},
      completedToday:{$sum:{$cond:[{$and:[today,{$eq:['$status','completed']}]},1,0]}},
      pendingReview:{$sum:{$cond:[{$in:['$paymentStatus',['pending','partial']]},1,0]}},
      confirmedWithoutTechnician:{$sum:{$cond:[{$and:[{$eq:['$status','confirmed']},{$eq:[{$ifNull:['$technicianId',null]},null]}]},1,0]}},
    }}],
    pipeline:[{$group:{_id:'$status',count:{$sum:1}}}],
    serviceDistribution:[{$group:{_id:'$serviceType',count:{$sum:1}}},{$sort:{count:-1}}],
  };
  trendDays.forEach((day,index)=>{facets['trend'+index]=[{$match:dateFilter(day.start,day.end)},{$count:'count'}];});
  return [{$project:{status:1,paymentStatus:1,bookingDate:1,createdAt:1,technicianId:1,serviceType:1}},{$facet:facets}];
}

async function dashboardBookingSummary(Booking, {startOfDay,endOfDay}) {
  const trendDays=[];
  for(let offset=6;offset>=0;offset--){
    const start=new Date(startOfDay);start.setDate(start.getDate()-offset);
    const end=new Date(start);end.setHours(23,59,59,999);
    trendDays.push({start,end,label:start.toLocaleDateString('en',{weekday:'short'})});
  }
  const rows=await Booking.aggregate(buildBookingSummaryPipeline(startOfDay,endOfDay,trendDays))
    .allowDiskUse(true).option({maxTimeMS:8000});
  const snapshot=rows[0]||{};
  const {_id,...totals}=snapshot.totals?.[0]||{};
  return {...totals,pipeline:snapshot.pipeline||[],serviceDistribution:snapshot.serviceDistribution||[],
    trend7:trendDays.map((day,index)=>({date:day.label,count:snapshot['trend'+index]?.[0]?.count||0})),
  };
}

module.exports={dateFilter,buildBookingSummaryPipeline,dashboardBookingSummary};
