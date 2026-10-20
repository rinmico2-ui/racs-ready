"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { bookingOverviewScheduleResolution, bookingResolutionCaseIsResolved, bookingIssueRequiresOutcome } = require("../utils/resolutionCenter");
const Booking = require("../models/BookingService");
const routes = require("../routes/appointmentManagement");
const view = fs.readFileSync(path.join(__dirname, "../views/pages/admin/Appointments/AppointmentsUnified.ejs"), "utf8").replace(/\r\n/g, "\n");
const now = new Date("2026-10-12T13:00:00+08:00");
const booking = patch => ({ _id:"507f191e810c19729de860ea", bookingReference:"RACS-TEST",
  status:"assigned", bookingDate:"2026-10-11", startTime:"08:00", endTime:"10:00",
  resolutionCases:[], ...patch });
const closed = (issueType = "past_date", sourceStatus = "assigned", state = "closed") => ({ issueType, sourceStatus, state });

test("a dismissed schedule case cannot resolve an unchanged past schedule", () => {
  for (const state of ["closed", "rescheduled", "reassigned"]) {
    const row = booking({ resolutionCases:[closed("past_date", "assigned", state)] });
    assert.deepEqual(bookingOverviewScheduleResolution(row, now), { required:true, issueType:'past_date' });
    assert.equal(row.status, "assigned");
  }
  assert.deepEqual(bookingOverviewScheduleResolution(booking(), now), { required:true, issueType:"past_date" });
});

test("decisions from another booking stage or another issue cannot hide an open schedule case", () => {
  for (const decision of [closed("past_date", "pending"), closed("no_show"), closed("past_date", "assigned", "open")]) {
    const row = booking({ resolutionCases:[decision] });
    assert.equal(bookingResolutionCaseIsResolved(row, "past_date"), false);
    assert.equal(bookingOverviewScheduleResolution(row, now).required, true);
  }
});

test("saved review notes cannot hide the missing date or technician", () => {
  const row = booking({ status:"awaiting_assignment", resolutionCases:[closed("past_date", "awaiting_assignment")] });
  assert.deepEqual(bookingOverviewScheduleResolution(row, now), { required:true, issueType:"past_date" });
  row.resolutionCases.push(closed("no_technician", "awaiting_assignment"));
  assert.equal(bookingOverviewScheduleResolution(row, now).required, true);
});

test("a pending replacement proposal is not an approved schedule", () => {
  const row = booking({ proposedReschedule:{status:"pending", date:"2026-10-15"}, resolutionCases:[closed()] });
  assert.deepEqual(bookingOverviewScheduleResolution(row, now), { required:true, issueType:"past_date" });
});

test("a confirmed future schedule clears the old warning even if an old recovery flag remains", () => {
  const row = booking({ status:"scheduled", bookingDate:"2026-10-15", autoReschedulePending:true, technicianId:"tech-1" });
  assert.deepEqual(bookingOverviewScheduleResolution(row, now), { required:false, issueType:null });
});

test("closing recovery and no-show notes cannot bypass a required schedule outcome", () => {
  assert.equal(bookingOverviewScheduleResolution(booking({ status:"reschedule-required" }), now).required, true);
  assert.equal(bookingOverviewScheduleResolution(booking({ status:"reschedule-required", resolutionCases:[closed("past_date", "reschedule-required")] }), now).required, true);
  const future = booking({ status:"reschedule-required", bookingDate:"2026-10-15" });
  assert.equal(bookingOverviewScheduleResolution(future, now).issueType, "no_show");
  future.resolutionCases = [closed("no_show", "reschedule-required")];
  assert.equal(bookingOverviewScheduleResolution(future, now).required, true);
});

test("finished or cancelled bookings never become overdue again from stale flags", () => {
  for (const status of ["cancelled", "completed", "closed", "repair_completed"]) {
    assert.equal(bookingOverviewScheduleResolution(booking({ status, autoReschedulePending:true }), now).required, false);
  }
});

test("schedule, assignment and customer-confirmation issues require an actual outcome", () => {
  const fixtures=[
    ['past_date',booking({status:'reschedule-required'})],
    ['no_show',booking({status:'reschedule-required',bookingDate:'2030-01-01'})],
    ['no_technician',booking({status:'awaiting_assignment',bookingDate:'2030-01-01'})],
    ['technician_issue',booking({status:'pending_reassignment',bookingDate:'2030-01-01'})],
    ['customer_reschedule',booking({status:'assigned',proposedReschedule:{status:'pending',date:'2030-01-01'}})],
  ];
  for(const [issue,row] of fixtures){
    assert.equal(bookingIssueRequiresOutcome(row,issue,now),true);
    row.resolutionCases=[closed(issue,row.status)];
    assert.equal(bookingResolutionCaseIsResolved(row,issue,now),false);
  }
  assert.equal(bookingIssueRequiresOutcome(booking({status:'scheduled',bookingDate:'2030-01-01',technicianId:'tech'}),'past_date',now),false);
});

test("staff cannot dismiss unfinished scheduling by Close case and no review or booking write is saved", async () => {
  const file=path.join(__dirname,'../routes/adminApi.js'),source=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');
  const begin=source.indexOf('router.post("/resolution-center/:id/close"'),start=source.indexOf('async (req, res, next) => {',begin),end=source.indexOf('\n});',start);
  const actualRequire=createRequire(file);let saves=0,audits=0;
  const row=booking({status:'reschedule-required',paymentStatus:'paid',bookingDate:'2020-01-01',save:async()=>{saves++;}});
  const handler=vm.runInNewContext('('+source.slice(start,end+2)+')',{
    mongoose:require('mongoose'),require:name=>name==='../models/BookingService'?{findById:async()=>row}
      :name==='../utils/audit'?{logEvent:async()=>{audits++;}}:actualRequire(name),
  });
  for(const role of ['admin','secretary']){
    const res={status(code){this.code=code;return this;},json(body){this.body=body;}};
    await handler({params:{id:row._id},body:{issueType:'past_date',note:'Reviewed'},user:{role}},res,error=>{throw error;});
    assert.equal(res.code,409);assert.equal(res.body.code,'BOOKING_OUTCOME_REQUIRED');assert.match(res.body.error,/Resolve case/);
  }
  assert.equal(saves,0);assert.equal(audits,0);assert.equal(row.resolutionCases.length,0);assert.equal(row.status,'reschedule-required');
});

test("compact booking API preserves resolution decisions and returns the current warning state for both staff roles", async t => {
  const handler = routes.stack.find(layer => layer.route?.path === "/list" && layer.route.methods.get).route.stack.at(-1).handle;
  const row = booking({ bookingDate:"2020-01-01", resolutionCases:[closed()] });
  let pipeline;
  t.mock.method(Booking, "aggregate", async value => { pipeline=value; return [row]; });
  t.mock.method(Booking, "countDocuments", async () => 1);
  for (const role of ["admin", "secretary"]) {
    const response = { json(value) { this.body=value; }, status(code) { assert.fail(`Unexpected ${code}`); } };
    await handler({ query:{compact:"true"}, user:{role} }, response);
    const actual = response.body.bookings[0];
    assert.equal(actual.overviewScheduleResolution.required, true);
    assert.equal(actual.status, "assigned");
    assert.equal(actual.resolutionCases[0].state, "closed");
    const projected = pipeline.find(stage => stage.$project).$project;
    for (const field of ["resolutionCases.issueType","resolutionCases.sourceStatus","resolutionCases.state"]) assert.equal(projected[field], 1);
  }
});

test("overview rows use the server's resolution result instead of reopening a closed case from an old date", () => {
  const start = view.indexOf("  function bookingStatusLabel(");
  const predicate = view.slice(start, view.indexOf("\n  function bookingResolutionUrl", start));
  const renderStart = view.indexOf("  AU.Overview.renderTable=function");
  const renderer = view.slice(renderStart, view.indexOf("\n  AU.Overview.renderPagination", renderStart));
  const tbody = { innerHTML:"" };
  const context = vm.createContext({ document:{getElementById:()=>tbody}, AU:{Overview:{}}, STATUS_CLASSES:{assigned:"st-assigned"},
    STATUS_LABELS:{}, RQ_STATUS_LABELS:{}, APPOINTMENTS_CAN_RESOLVE:true, statusLabel:value=>value, qEsc:String, _ovViewBtn:()=>'<button>View</button>', bookingResolutionUrl:()=>'/resolution-center' });
  vm.runInContext(predicate + renderer, context);
  context.AU.Overview.renderTable([booking({overviewScheduleResolution:{required:false,issueType:null}})]);
  assert.doesNotMatch(tbody.innerHTML, />Resolve<|Needs Resolution|Past schedule/);
  assert.match(tbody.innerHTML, />assigned<\/span>/);
  context.AU.Overview.renderTable([booking({overviewScheduleResolution:{required:true,issueType:"past_date"}})]);
  assert.match(tbody.innerHTML, />Resolve<\/a>/);
});

test("closing a cancelled-booking review is reflected by both overview and popup for both staff roles", async t => {
  const Payment = require('../models/Payment');
  const Assignment = require('../models/Assignment');
  const Reservation = require('../models/StockReservation');
  const file = path.join(__dirname, '../routes/adminApi.js');
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const begin = source.indexOf('router.post("/resolution-center/:id/close"');
  const start = source.indexOf('async (req, res, next) => {', begin);
  const end = source.indexOf('\n});', start);
  const actualRequire = createRequire(file);
  let row, saves;
  const closeHandler = vm.runInNewContext('(' + source.slice(start, end + 2) + ')', {
    mongoose:require('mongoose'), require:name=> name==='../models/BookingService' ? {findById:async()=>row}
      : name==='../utils/audit' ? {logEvent:async()=>{}} : actualRequire(name),
  });
  const plainRow = () => { const {save, ...fields}=row; return fields; };
  const chain = value => ({select(){return this;},populate(){return this;},sort(){return this;},maxTimeMS(){return this;},lean:async()=>value});
  t.mock.method(Booking, 'findById', ()=>chain(plainRow()));
  t.mock.method(Booking, 'aggregate', async()=>[plainRow()]);
  t.mock.method(Booking, 'countDocuments', async()=>1);
  t.mock.method(Payment, 'find', ()=>chain([]));
  t.mock.method(Assignment, 'find', ()=>chain([]));
  t.mock.method(Assignment, 'findOne', ()=>chain(null));
  t.mock.method(Reservation, 'find', ()=>chain([]));
  const list = routes.stack.find(layer=>layer.route?.path==='/list').route.stack.at(-1).handle;
  const detail = routes.stack.find(layer=>layer.route?.path==='/:id' && layer.route.methods.get).route.stack.at(-1).handle;
  const response = () => ({set(){},json(value){this.body=value;},status(code){assert.fail(`Unexpected ${code}`);}});
  const helpersStart=view.indexOf('  function bookingStatusLabel(');
  const helpers=view.slice(helpersStart, view.indexOf('  function bookingResolutionUrl(', helpersStart));
  const presentation=vm.createContext({STATUS_LABELS:{}, RQ_STATUS_LABELS:{}, statusLabel:value=>value});
  vm.runInContext(helpers, presentation);
  for (const role of ['admin','secretary']) {
    row=booking({status:'cancelled',bookingDate:'2020-01-01', save:async()=>{saves++;}});saves=0;
    const closedResponse=response();
    await closeHandler({params:{id:String(row._id)},body:{issueType:'cancelled',note:'Customer contacted; issue reviewed'},user:{role}},closedResponse,error=>{throw error;});
    assert.equal(closedResponse.body.success,true);assert.equal(saves,1);
    assert.equal(row.status,'cancelled');assert.equal(row.resolutionCases[0].state,'closed');
    const listResponse=response();await list({query:{compact:'true'},user:{role}},listResponse);
    const overviewRow=listResponse.body.bookings[0];
    for (const query of [{}, {view:'modal'}]) {
      const detailResponse=response();await detail({params:{id:String(row._id)},query,user:{role}},detailResponse);
      const popupRow=detailResponse.body.booking;
      assert.deepEqual(popupRow.overviewScheduleResolution,overviewRow.overviewScheduleResolution);
      assert.equal(presentation.bookingNeedsResolution(popupRow),false);
      assert.match(presentation.bookingClosedCasesHTML(popupRow),/Case closed/);
      assert.equal(popupRow.status,'cancelled');
    }
  }
});

test("case-closed labels distinguish saved reviews from another remaining issue or an older booking stage", () => {
  const start=view.indexOf('  function bookingClosedCasesHTML(');
  const implementation=view.slice(start,view.indexOf('  function bookingNeedsResolution(',start));
  const context=vm.createContext({bookingNeedsResolution:b=>Boolean(b.overviewScheduleResolution?.required)});vm.runInContext(implementation,context);
  assert.match(context.bookingClosedCasesHTML(booking({resolutionCases:[closed(),closed()]})),/Case closed/);
  assert.match(context.bookingClosedCasesHTML(booking({resolutionCases:[closed(),closed('no_technician')]})),/2 cases closed/);
  assert.equal(context.bookingClosedCasesHTML(booking({resolutionCases:[closed('past_date','pending')]})), '');
  const row=booking({status:'awaiting_assignment',resolutionCases:[closed('past_date','awaiting_assignment')]});
  row.overviewScheduleResolution=bookingOverviewScheduleResolution(row,now);
  assert.match(context.bookingClosedCasesHTML(row),/Review saved/);
  assert.doesNotMatch(context.bookingClosedCasesHTML(row),/Case closed/);
  assert.equal(row.overviewScheduleResolution.issueType,'past_date');
});

test("returning from the resolution page coalesces browser events and refreshes only the active overview", async () => {
  const start = view.indexOf("  var overviewReturnTimer=");
  const implementation = view.slice(start, view.indexOf("\n  function auInit()", start));
  const windowEvents = {}, documentEvents = {}, timers = new Map(), calls = [];
  let sequence = 0, active = true, release;
  const pending = new Promise(resolve => { release=resolve; });
  const document = { hidden:false, querySelector:()=>active ? {} : null, addEventListener:(type, callback)=>documentEvents[type]=callback };
  const context = vm.createContext({ document, window:{ addEventListener:(type, callback)=>windowEvents[type]=callback,
    clearTimeout:id=>timers.delete(id), setTimeout:callback=>{ const id=++sequence; timers.set(id, callback); return id; } },
    AU:{Overview:{ load:options=>{ calls.push(["overview",options]);return pending; } }},
    loadBookingResolutionCount:()=>calls.push(["count"]), console,
  });
  vm.runInContext(implementation, context);
  windowEvents.pageshow({persisted:false}); assert.equal(timers.size, 0);
  windowEvents.pageshow({persisted:true}); windowEvents.focus(); documentEvents.visibilitychange();
  assert.equal(timers.size, 1);
  [...timers.values()][0](); timers.clear();
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].preservePage, true);
  windowEvents.focus(); assert.equal(timers.size, 0);
  release(); await new Promise(setImmediate);
  document.hidden=true; windowEvents.focus(); assert.equal(timers.size, 0);
  document.hidden=false; active=false; windowEvents.focus(); assert.equal(timers.size, 0);
  active=true; windowEvents.focus(); assert.equal(timers.size, 1);
});

test("return refresh preserves the overview page, search and status filters", async () => {
  const start = view.indexOf("  AU.Overview.load=function");
  const implementation = view.slice(start, view.indexOf("\n  AU.Overview.searchRecent", start));
  const elements = { statusFilter:{value:"assigned"}, overviewSearchInput:{value:"RACS-TEST"}, filterStartDate:{value:"2026-10-11"}, filterEndDate:{value:""} };
  const requests = [];
  const context = vm.createContext({ document:{getElementById:id=>elements[id]}, APPOINTMENTS_API:"/api/admin/appointments",
    _overviewStatsRequest:0,_overviewListRequest:0,_ovPage:3,_ovLimit:10,
    AU:{Overview:{renderPipeline() {},renderKPIs() {},renderTable() {},renderPagination() {}}},
    fetch:async (url, options)=>{ requests.push({url,options});return {json:async()=>url.includes("flow-stats")?{}:{bookings:[],pagination:{page:3}}}; },
    appointmentResponseJson:res=>res.json(), console,
  });
  vm.runInContext(implementation, context);
  await context.AU.Overview.load({preservePage:true});
  assert.equal(requests.length, 2);
  const list = requests.find(row=>row.url.includes("/list?"));
  assert.match(list.url, /page=3&limit=10/);
  assert.match(list.url, /status=assigned/);
  assert.match(list.url, /search=RACS-TEST/);
  assert.match(list.url, /date=2026-10-11/);
  assert.ok(requests.every(row=>row.options.cache==="no-store"));
});

test("slow or failed statistics do not delay or clear the updated booking rows", async () => {
  const start = view.indexOf("  AU.Overview.load=function");
  const implementation = view.slice(start, view.indexOf("\n  AU.Overview.searchRecent", start));
  let failStats;
  const statistics = new Promise((_, reject) => { failStats=reject; });
  const rows = [booking({overviewScheduleResolution:{required:false,issueType:null}})];
  const rendered = [];
  const context = vm.createContext({ document:{getElementById:()=>({value:""})}, APPOINTMENTS_API:"/api/admin/appointments",
    _overviewStatsRequest:0,_overviewListRequest:0,_ovPage:1,_ovLimit:10,
    AU:{Overview:{renderPipeline() {},renderKPIs() {},renderTable:data=>rendered.push(data),renderPagination() {}}},
    fetch:url=>url.includes("flow-stats") ? statistics : Promise.resolve({json:async()=>({bookings:rows,pagination:{page:1}})}),
    appointmentResponseJson:res=>res.json(), console:{error() {}},
  });
  vm.runInContext(implementation, context);
  const pending = context.AU.Overview.load();
  await new Promise(setImmediate);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0], rows);
  failStats(new Error("Statistics unavailable"));
  await pending;
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0], rows);
});
