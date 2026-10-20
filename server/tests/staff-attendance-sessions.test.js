'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), { spawnSync } = require('node:child_process');
const { attendanceDay, attendanceShift } = require('../utils/attendanceTime');
const { chooseRecord, sessionState } = require('../utils/staffAttendanceSessions');
const fixed = new Date('2030-01-10T02:00:00Z');

test('a current open overnight shift takes priority over a new day with no attendance', () => {
  const yesterday = new Date(attendanceDay(fixed).start.getTime() - 86400000);
  const record = { _id:'previous', date:yesterday, status:'Late', checkInTime:new Date('2030-01-09T22:00:00+08:00'), checkOutTime:null };
  assert.equal(chooseRecord([record], fixed)._id, 'previous');
  assert.equal(sessionState(record, fixed).isOvernight, true);
  assert.equal(sessionState(record, fixed).needsAdminReview, false);
  assert.equal(chooseRecord([{ ...record, checkOutTime:fixed }], fixed), null, 'closing the old shift leaves today available for a new check-in');
  assert.equal(sessionState({ ...record, date:new Date(yesterday.getTime()-86400000) }, fixed).needsAdminReview, true);
});

test('shift deadlines preserve the daytime grace cutoff and follow later and overnight starts', () => {
  const day = attendanceDay(fixed);
  assert.equal(attendanceShift(day).checkInDueAt.toISOString(), '2030-01-10T01:00:00.000Z');
  assert.equal(attendanceShift(day, { shift:'11:00-20:00' }).checkInDueAt.toISOString(), '2030-01-10T03:00:00.000Z');
  const night = attendanceShift(day, { shift:'22:00-06:00' });
  assert.equal(night.checkInDueAt.toISOString(), '2030-01-10T14:00:00.000Z');
  assert.equal(night.checkOutDueAt.toISOString(), '2030-01-10T22:00:00.000Z');
});

for (const timezone of ['UTC', 'Asia/Manila']) test('availability stays consistent under server timezone ' + timezone, () => {
  const script = `
    const assert=require('node:assert/strict'), availability=require('./server/utils/availability');
    const Attendance=require('./server/models/TechnicianAttendance'), Leave=require('./server/models/LeaveRequest');
    const NativeDate=Date, now=new NativeDate('2030-01-10T02:00:00Z');
    global.Date=class extends NativeDate { constructor(...args){super(...(args.length?args:[now]));} static now(){return now.getTime();} };
    const day=new Date('2030-01-10T00:00:00+08:00'), rows=[{technicianId:'tech',date:day,status:'Late',checkInTime:new Date('2030-01-10T09:30:00+08:00'),checkOutTime:null}];
    let queries=0;
    Attendance.find=filter=>{queries++;assert.equal(filter.$or[0].date.toISOString(),'2030-01-09T16:00:00.000Z');return{lean:async()=>rows};};
    Attendance.findOne=()=>{throw Error('Unexpected fallback attendance query');};
    Leave.findOne=()=>({lean:async()=>null}); Leave.find=()=>({lean:async()=>[]});
    (async()=>{
      assert.equal(await availability.resolveAvailabilityStatus({_id:'tech',availabilityStatus:'Available'},null,null,{syncDb:false}),'Available');
      const before=queries, statuses=await availability.resolveAvailabilityBulk([{_id:'tech',availabilityStatus:'Assigned'},{_id:'missing',availabilityStatus:'Available'}]);
      assert.equal(statuses.get('tech'),'Assigned'); assert.equal(statuses.get('missing'),'Offline'); assert.equal(queries-before,1);
      rows[0].date=new Date(day.getTime()-86400000);rows[0].checkInTime=new Date('2030-01-09T22:00:00+08:00');
      assert.equal(await availability.resolveAvailabilityStatus({_id:'tech',availabilityStatus:'In Progress'},null,null,{syncDb:false}),'In Progress');
      rows[0].date=new Date(day.getTime()-3*86400000);
      assert.equal(await availability.resolveAvailabilityStatus({_id:'tech',availabilityStatus:'Available'},null,null,{syncDb:false}),'Offline');
      console.log('Timezone and batch resolution verified.');
    })().catch(error=>{console.error(error.stack);process.exitCode=1;});`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd:path.join(__dirname,'../..'), env:{...process.env,TZ:timezone}, encoding:'utf8', timeout:10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('an older request delayed across midnight cannot open a second shift after a newer check-in', async () => {
  const {createService} = require('../utils/staffAttendanceSessions');
  const received = new Date('2030-01-10T23:59:59.900+08:00'), acquired = new Date('2030-01-11T00:00:00.100+08:00');
  const record = {_id:'new-day',date:attendanceDay(acquired).start,status:'Present',checkInTime:acquired,checkOutTime:null};
  const service = createService({now:()=>acquired,lock:async(_key,work)=>work(),SecretaryAttendance:{
    find(filter){assert.equal(filter.$or[0].date.getTime(),record.date.getTime());return{select(){return this;},lean:async()=>[record]};},
    findOneAndUpdate(){assert.fail('A second shift must not be created');},
  }});
  await assert.rejects(service.checkIn('secretary','507f1f77bcf86cd799439011',{now:received}),error=>error.code==='ALREADY_CHECKED_IN');
});
