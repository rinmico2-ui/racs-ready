'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const scheduling=require('../utils/repairScheduling');
const id=n=>n.toString(16).padStart(24,'0');
function fixture(){
  const booking={_id:id(1),technicianId:id(2),status:'repair_scheduled',repairExecution:{repairMinutes:120},travelTime:20,
    technicianAssistant:{estimatedDurationMinutes:30},technicianTeam:[{technicianId:id(2)},{technicianId:id(3)}]};
  const calls=[];
  const service=scheduling.createService({now:()=>new Date('2035-01-01T00:00:00Z'),
    roster:async({technicianIds})=>technicianIds.map(_id=>({_id,assignmentEligible:true})),
    slots:async(query,options)=>{calls.push({query,options});return{statusCode:200,payload:{timeSlots:[
      {startTime:'8:00 AM',available:true},...(query.technicianId===id(3)?[]:[{startTime:'9:00 AM',available:true}])
    ]}};}
  });
  return{booking,calls,service};
}
test('Phase 2 slot checks exclude the appointment itself and use the saved repair duration for every crew member',async()=>{
  const f=fixture(),result=await f.service(f.booking,id(4),'2035-01-02');
  assert.deepEqual(result.technicianIds,[id(4),id(3)]);
  assert.deepEqual(result.timeSlots.map(row=>row.startTime),['8:00 AM']);
  assert.ok(f.calls.every(call=>call.options.excludeBookingId===id(1)&&call.options.existingAppointment===true));
  assert.ok(f.calls.every(call=>call.query.duration==='120'&&call.query.travelTime==='20'));
});
test('repair dates and times come from the same shared crew availability checks',async()=>{
  const f=fixture(),dates=await f.service(f.booking,id(2));
  assert.equal(dates.dates.length,14);
  for(const row of dates.dates){const day=await f.service(f.booking,id(2),row.date);assert.equal(row.remainingSlots,day.timeSlots.length);}
});
test('invalid dates, ineligible crew and started repairs fail without changing the booking',async()=>{
  const f=fixture(),before=structuredClone(f.booking);
  await assert.rejects(f.service(f.booking,id(2),'bad-date'),{status:400});
  const unavailable=scheduling.createService({roster:async()=>[]});
  await assert.rejects(unavailable(f.booking,id(2),'2035-01-02'),/unavailable/);
  await assert.rejects(f.service({...f.booking,status:'repair_in_progress'},id(2),'2035-01-02'),/current status/);
  assert.deepEqual(f.booking,before);
});
test('a failed scheduler response is reported instead of presenting guessed dates',async()=>{
  const f=fixture(),service=scheduling.createService({roster:async({technicianIds})=>technicianIds.map(_id=>({_id,assignmentEligible:true})),slots:async()=>({statusCode:503,payload:{error:'Scheduler unavailable'}})});
  await assert.rejects(service(f.booking,id(2),'2035-01-02'),{status:503});
});
