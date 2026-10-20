'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),express=require('express'),mongoose=require('mongoose'),path=require('node:path');
const {requireRole}=require('../middleware/authenticate');
const realTime=require('../utils/attendanceTime'),security=require('../utils/attendanceSecurity');
process.env.ATTENDANCE_QR_SECRET='isolated-attendance-audit-signing-secret';
let now=new Date('2030-01-10T02:00:00Z');
class AuditDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now.getTime();}}
const T='507f1f77bcf86cd799439011',U='507f1f77bcf86cd799439012',S='507f1f77bcf86cd799439013',A='507f1f77bcf86cd799439014';
const day=()=>realTime.attendanceDay(now);
const same=(a,b)=>a instanceof Date||b instanceof Date?new Date(a).getTime()===new Date(b).getTime():String(a)===String(b);
function match(row,filter){return row&&Object.entries(filter).every(([key,value])=>key==='$or'?value.some(clause=>match(row,clause)):value&&typeof value==='object'&&!(value instanceof Date)&&!value._bsontype?Object.entries(value).every(([op,term])=>op==='$exists'?(row[key]!==undefined)===term:op==='$ne'?row[key]!==term:op==='$lt'?row[key]<term:op==='$lte'?row[key]<=term:op==='$gte'?row[key]>=term:op==='$in'?term.includes(row[key]):false):value===null?row[key]==null:same(row[key],value));}
function query(work){return{select(){return this;},populate(){return this;},sort(){return this;},limit(){return this;},lean(){return Promise.resolve().then(work);},then(ok,bad){return Promise.resolve().then(work).then(ok,bad);}};}
function fixture(){
 const state={tech:null,secretary:null,active:[],completed:[],payments:[],expenseCount:1,completedCount:0,leave:null,trusted:true,locationCode:null,writes:[],filters:[]};
 const tech={_id:T,user:U,availabilityStatus:'Offline',async save(){state.writes.push('technician');}};
 const clone=row=>row?{...row}:null;
 function attendance(key,identity){return{
  findOne(filter){state.filters.push({key,filter});const snapshot=match(state[key],filter)?clone(state[key]):null;return query(async()=>{if(state.readBarrier)await state.readBarrier(key);return snapshot?{...snapshot,async save(){state[key]={...this};delete state[key].save;state.writes.push(key);}}:null;});},
  find(filter){state.filters.push({key,filter});return query(()=>state[key]&&match(state[key],filter)?[clone(state[key])]:[]);},
  async findOneAndUpdate(filter,update,options){let row=match(state[key],filter)?state[key]:null;if(!row){if(!options?.upsert)return null;if(state[key]&&same(state[key][identity],filter[identity])&&same(state[key].date,filter.date))throw Object.assign(Error('Duplicate'),{code:11000});row={_id:key==='tech'?'507f1f77bcf86cd799439031':'507f1f77bcf86cd799439032',date:filter.date,[identity]:filter[identity]};}Object.assign(row,update.$set);for(const k of Object.keys(update.$unset||{}))delete row[k];state[key]=row;state.writes.push(key);return clone(row);}
 };}
 const techAttendance=attendance('tech','technicianId'),secretaryAttendance=attendance('secretary','userId');
 const models={Technician:{findOne(filter){assert.equal(String(filter.user),U);return query(()=>tech);},findById(){return Promise.resolve(tech);}},TechnicianAttendance:techAttendance,SecretaryAttendance:secretaryAttendance,
  LeaveRequest:{findOne(){return query(()=>state.leave);}},Assignment:{find(filter){return query(()=>filter.status==='completed'?state.completed:state.active);},countDocuments:async()=>state.completedCount},Payment:{find(){return query(()=>state.payments);}},Expense:{countDocuments:async()=>state.expenseCount}};
 const queues=new Map(),lock=async(key,work)=>{const previous=queues.get(key)||Promise.resolve();let release;const held=new Promise(resolve=>{release=resolve;});queues.set(key,held);await previous;try{return await work();}finally{release();if(queues.get(key)===held)queues.delete(key);}};
 const sessionService=require('../utils/staffAttendanceSessions').createService({TechnicianAttendance:techAttendance,SecretaryAttendance:secretaryAttendance,TechnicianSchedule:{findOne:()=>query(()=>state.schedule||null)},Secretary:{findOne:()=>query(()=>state.secretaryProfile||null)},lock,now:()=>now});
 const attendanceTime={...realTime,attendanceDay:(value=now)=>realTime.attendanceDay(value)};
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={_id:req.headers['x-role']==='secretary'?S:req.headers['x-role']==='admin'?A:U,role:req.headers['x-role']};next();});
 const dependencies={...security,attendanceDay:attendanceTime.attendanceDay,verifyAttendanceLocation:async()=>{if(state.locationCode)throw Object.assign(Error('Location rejected'),{name:'AttendanceSecurityError',code:state.locationCode,status:403});return{latitude:15,longitude:120,accuracyMeters:5};}};
 function load(role,source,context){const router=express.Router();router.use(requireRole(role));vm.runInNewContext(source,{...context,staffAttendance:sessionService,router,Date:AuditDate,console,require(name){const model=models[name.split('/').at(-1)];if(model)return model;if(name.endsWith('/attendanceTime'))return attendanceTime;if(name.endsWith('/attendanceSecurity'))return security;if(name.endsWith('/staffAttendanceSessions'))return{createService:()=>sessionService};if(name.endsWith('/availability'))return{computeAttendanceStatus:require('../utils/availability').computeAttendanceStatus,resolveAvailabilityStatus:async()=>state.tech?.checkOutTime?'Offline':state.tech?'Available':'Offline'};if(name.endsWith('/staffAttendanceRoster'))return{loadStaffAttendanceRoster:async()=>[]};throw Error('Unexpected isolated dependency '+name);}});app.use('/api/'+role,router);}
 const techSource=fs.readFileSync(path.join(__dirname,'../routes/technicianApi.js'),'utf8');
 load('technician',techSource.slice(techSource.lastIndexOf('const Technician = require("../models/Technician");',techSource.indexOf('const attendanceActionLimiter')),techSource.indexOf('router.post("/availability"')),{...dependencies,rateLimit:()=>((_req,_res,next)=>next()),trustedDevices:{validateAndRotate:async()=>state.trusted},audit:{logEvent:async()=>{} }});
 const secSource=fs.readFileSync(path.join(__dirname,'../routes/secretaryApi.js'),'utf8');
 load('secretary',secSource.slice(secSource.indexOf('router.get("/attendance/status"'),secSource.indexOf('// Dashboard KPI')),{...dependencies,SecretaryAttendance:secretaryAttendance,audit:{logEvent:async()=>{}}});
 const adminSource=fs.readFileSync(path.join(__dirname,'../routes/adminApi.js'),'utf8');const start=adminSource.lastIndexOf('const Technician = require("../models/Technician");',adminSource.indexOf('const { attendanceDay, attendanceRange }'));const end=adminSource.indexOf('/** GET /api/admin/attendance/history');
 load('admin',adminSource.slice(start,end),{mongoose,QRCode:require('qrcode'),User:{findOne(){return query(()=>({_id:S,role:'secretary'}));},exists:async()=>true},audit:{logEvent:async()=>{} }});
 app.use((err,_req,res,_next)=>{res.status(500).json({error:err.message});});
 return{state,async start(t){const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));return async(role,target,body,method=body===undefined?'GET':'POST')=>{const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/'+target,{method,headers:{'x-role':role,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:res.status,body:await res.json(),headers:res.headers};};},checkinRecord(role='tech',status='Late'){state[role]={_id:role==='tech'?'507f1f77bcf86cd799439031':'507f1f77bcf86cd799439032',...(role==='tech'?{technicianId:T}:{userId:S}),date:day().start,status,checkInTime:new Date(now.getTime()-3600000),checkOutTime:null};}};
}
const token=()=>security.createAttendanceChallenge(now).token;
test('normal technician QR check-in, duplicate rejection, privacy, history and check-out operate',async t=>{const f=fixture(),call=await f.start(t);let res=await call('technician','technician/attendance/scan',{token:token(),location:{},userId:'victim'});assert.equal(res.status,200);assert.equal(res.body.attendanceStatus,'Late');assert.equal(f.state.tech.userId,U);assert.equal(res.body.record.checkInEvidence,undefined);assert.equal((await call('technician','technician/attendance/scan',{token:token(),location:{}})).status,409);assert.equal((await call('technician','technician/attendance/history')).body.count,1);res=await call('technician','technician/attendance/checkout',{location:{}});assert.equal(res.status,200);assert.ok(res.body.record.checkOutTime);assert.equal((await call('technician','technician/attendance/status')).body.attendanceStatus,'Checked Out');assert.equal((await call('technician','technician/attendance/checkout',{location:{}})).status,400);});
test('technician device, leave, manual bypass, active-job, remittance and expense checks refuse blocked writes',async t=>{const f=fixture(),call=await f.start(t);f.state.trusted=false;assert.equal((await call('technician','technician/attendance/scan',{token:token(),location:{}})).body.code,'TRUSTED_DEVICE_REQUIRED');f.state.trusted=true;f.state.leave={reason:'Approved leave'};assert.equal((await call('technician','technician/attendance/scan',{token:token(),location:{}})).status,400);f.state.leave=null;assert.equal((await call('technician','technician/attendance/checkin',{})).body.code,'ADMIN_OVERRIDE_REQUIRED');assert.equal(f.state.writes.length,0);f.checkinRecord();f.state.active=[{_id:'job'}];assert.equal((await call('technician','technician/attendance/checkout',{location:{}})).body.code,'ACTIVE_JOB_REMAINING');f.state.active=[];f.state.payments=[{amount:500}];assert.equal((await call('technician','technician/attendance/checkout',{location:{}})).body.code,'REMITTANCE_REQUIRED');f.state.payments=[];f.state.expenseCount=0;assert.equal((await call('technician','technician/attendance/checkout',{location:{}})).body.code,'EXPENSE_CONFIRMATION_REQUIRED');assert.equal((await call('technician','technician/attendance/checkout',{location:{},noExpensesToday:true})).status,200);});
test('normal secretary scan, history and check-out use their own signed-in account',async t=>{const f=fixture(),call=await f.start(t);assert.equal((await call('secretary','secretary/attendance/checkout',{})).status,409);let res=await call('secretary','secretary/attendance/scan',{token:token(),userId:'victim'});assert.equal(res.status,200);assert.equal(f.state.secretary.userId,S);assert.equal((await call('secretary','secretary/attendance/scan',{token:token()})).status,409);assert.equal((await call('secretary','secretary/attendance/history')).body.count,1);assert.equal((await call('secretary','secretary/attendance/checkout',{})).status,200);assert.equal((await call('secretary','secretary/attendance/status')).body.attendanceStatus,'Checked Out');assert.equal((await call('secretary','secretary/attendance/checkout',{})).status,409);});
test('roles cannot clock in through another role or obtain the administrator QR',async t=>{const f=fixture(),call=await f.start(t);for(const role of ['technician','secretary','customer'])assert.equal((await call(role,'admin/attendance/qr-token')).status,403);assert.equal((await call('technician','secretary/attendance/scan',{token:token()})).status,403);assert.equal((await call('secretary','technician/attendance/scan',{token:token()})).status,403);const qr=await call('admin','admin/attendance/qr-token');assert.equal(qr.status,200);assert.ok(qr.body.qrImage.startsWith('data:image/png'));assert.ok(qr.headers.get('cache-control').includes('no-store'));assert.equal(qr.body.challengeId,undefined);});
test('admin checkout preserves the technician Late status',async t=>{const f=fixture(),call=await f.start(t);f.checkinRecord();const res=await call('admin','admin/attendance/'+T,{staffType:'technician',status:'Checked Out',overrideReason:'Verified end of shift.'},'PATCH');assert.equal(res.status,200);assert.equal(f.state.tech.status,'Late');assert.ok(f.state.tech.checkOutTime);});
test('secretary checkout closes the open shift on its original work date after midnight',async t=>{const f=fixture(),call=await f.start(t);f.checkinRecord('secretary');f.state.secretary.date=new Date(day().start.getTime()-86400000);const res=await call('secretary','secretary/attendance/checkout',{});assert.equal(res.status,200);assert.ok(f.state.secretary.checkOutTime);assert.equal(f.state.secretary.date.getTime(),day().start.getTime()-86400000);});

for(const role of ['secretary','technician'])test('parallel check-ins create one accepted submission for '+role,async t=>{
 const f=fixture(),call=await f.start(t);
 const results=await Promise.all([call(role,role+'/attendance/scan',{token:token(),location:{}}),call(role,role+'/attendance/scan',{token:token(),location:{}})]);
 assert.deepEqual(results.map(res=>res.status).sort(),[200,409]);
 assert.equal(f.state.writes.filter(key=>key===(role==='technician'?'tech':'secretary')).length,1);
});
test('technician checkout also closes an overnight shift on its original date',async t=>{const f=fixture(),call=await f.start(t);f.checkinRecord();f.state.tech.date=new Date(day().start.getTime()-86400000);const res=await call('technician','technician/attendance/checkout',{location:{}});assert.equal(res.status,200);assert.ok(f.state.tech.checkOutTime);assert.equal(f.state.tech.date.getTime(),day().start.getTime()-86400000);});

test('admin verified closure keeps the original day, check-in and lateness; other roles cannot close staff shifts',async t=>{
 const f=fixture(),call=await f.start(t);f.checkinRecord();f.state.tech.date=new Date(day().start.getTime()-3*86400000);f.state.tech.checkInTime=new Date(f.state.tech.date.getTime()+8*3600000);const before=f.state.tech.checkInTime;
 const body={staffType:'technician',recordId:f.state.tech._id,checkOutLocal:realTime.attendanceDay(f.state.tech.date).key+'T17:00',overrideReason:'Finish time verified with the technician.'};
 for(const role of ['technician','secretary','customer'])assert.equal((await call(role,'admin/attendance/'+T+'/close-shift',body)).status,403);
 const res=await call('admin','admin/attendance/'+T+'/close-shift',body);assert.equal(res.status,200);assert.equal(f.state.tech.status,'Late');assert.equal(f.state.tech.checkInTime.getTime(),before.getTime());assert.equal(f.state.tech.checkOutTime.toISOString(),realTime.attendanceDay(f.state.tech.date).key+'T09:00:00.000Z');assert.equal((await call('admin','admin/attendance/'+T+'/close-shift',body)).status,409);
});
test('invalid availability cannot partly update attendance and admin checkout cannot invent a check-in',async t=>{
 const f=fixture(),call=await f.start(t);assert.equal((await call('admin','admin/attendance/'+T,{status:'Present',availabilityStatus:'invalid',overrideReason:'Verified presence.'},'PATCH')).status,400);assert.equal(f.state.writes.length,0);assert.equal((await call('admin','admin/attendance/'+T,{status:'Checked Out',overrideReason:'Verified presence.'},'PATCH')).status,409);assert.equal(f.state.writes.length,0);
});
test('saved late shifts mark staff present before their shift cutoff',async t=>{
 const f=fixture(),call=await f.start(t),weekday=new Date(day().start.getTime()+8*3600000).getUTCDay();
 f.state.schedule={workingDays:[{dayOfWeek:weekday,startMinutes:660,endMinutes:1200}]};f.state.secretaryProfile={shift:'11:00-20:00'};
 for(const role of ['technician','secretary'])assert.equal((await call(role,role+'/attendance/scan',{token:token(),location:{}})).body.attendanceStatus,'Present');
});

test('overnight status identifies the original work date and older forgotten shifts require an audited correction', async t => {
  for (const role of ['technician', 'secretary']) {
    const f = fixture(), call = await f.start(t), key = role === 'technician' ? 'tech' : 'secretary';
    f.checkinRecord(key);
    f.state[key].date = new Date(day().start.getTime() - 86400000);
    const overnight = await call(role, role + '/attendance/status');
    assert.equal(overnight.body.isOvernight, true);
    assert.equal(overnight.body.attendanceDate || overnight.body.date, realTime.attendanceDay(f.state[key].date).key);
    f.state[key].date = new Date(day().start.getTime() - 3 * 86400000);
    const stale = await call(role, role + '/attendance/status');
    assert.equal(stale.body.needsAdminReview, true);
    const checkout = await call(role, role + '/attendance/checkout', { location: {} });
    assert.equal(checkout.status, 409);
    assert.equal(checkout.body.code, 'OPEN_SHIFT_REVIEW_REQUIRED');
    const scan = await call(role, role + '/attendance/scan', { token: token(), location: {} });
    assert.equal(scan.status, 409);
    assert.equal(scan.body.code, 'OPEN_SHIFT_REVIEW_REQUIRED');
    assert.equal(f.state.writes.length, 0);
  }
});

test('parallel checkouts record a single finish time for each staff role', async t => {
  for (const role of ['technician', 'secretary']) {
    const f = fixture(), call = await f.start(t), key = role === 'technician' ? 'tech' : 'secretary';
    f.checkinRecord(key);
    const results = await Promise.all([call(role, role + '/attendance/checkout', { location: {} }), call(role, role + '/attendance/checkout', { location: {} })]);
    assert.equal(results.filter(response => response.status === 200).length, 1);
    assert.ok(results.some(response => [400, 409].includes(response.status)));
    assert.equal(f.state.writes.filter(value => value === key).length, 1);
  }
});

test('verified closure rejects a different record, malformed dates, future finishes, early finishes and missing reasons without writes', async t => {
  const f = fixture(), call = await f.start(t); f.checkinRecord();
  const base = { staffType: 'technician', recordId: f.state.tech._id, checkOutLocal: '2030-01-10T10:00', overrideReason: 'Verified finish time.' };
  for (const values of [{ recordId: '507f1f77bcf86cd799439099' }, { checkOutLocal: '2030-02-30T08:00' }, { checkOutLocal: '2030-01-11T10:00' }, { checkOutLocal: '2030-01-10T08:00' }, { overrideReason: '' }, { overrideReason: { invalid: true } }]) {
    const response = await call('admin', 'admin/attendance/' + T + '/close-shift', { ...base, ...values });
    assert.ok([400, 409].includes(response.status)); assert.equal(f.state.writes.length, 0);
  }
});

test('check-in uses the same exact late cutoff as the roster', async t => {
  const original = now; t.after(() => { now = original; });
  for (const [instant, status] of [['2030-01-10T11:00:00+08:00', 'Present'], ['2030-01-10T11:00:00.001+08:00', 'Late']]) {
    now = new Date(instant);
    const f = fixture(), call = await f.start(t); f.state.secretaryProfile = { shift: '11:00-20:00' };
    assert.equal((await call('secretary', 'secretary/attendance/scan', { token: token() })).body.attendanceStatus, status);
    const state = require('../utils/staffAttendanceRoster').staffDayState({ day: day(), now, shift: '11:00-20:00' });
    assert.equal(state.missingCheckIn, status === 'Late');
  }
});

test('empty scan requests are rejected as validation errors without recording attendance', async t => {
  const f=fixture(), call=await f.start(t);
  for(const role of ['technician','secretary']) assert.equal((await call(role,role+'/attendance/scan',undefined,'POST')).status,400);
  assert.equal(f.state.writes.length,0);
});
