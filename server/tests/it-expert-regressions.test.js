'use strict';
const test = require('node:test');
const { install: installMathChallenge, signedRequest } = require("./helpers/mathChallenge");
installMathChallenge(test);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mongoose = require('mongoose');
const { availability } = require('../public/js/product-availability');
const catalog = require('../utils/psgcCatalog');
const { validateLeaveDates } = require('../utils/leaveRequestValidation');
const { parseInventoryCsv, csvTemplate } = require('../utils/inventoryCsv');
const bulkPolicy = require('../utils/bulkPayrollPolicy');
const { invoicePipeline } = require('../utils/invoiceRegister');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const id = '507f1f77bcf86cd799439021';
const userId = '507f1f77bcf86cd799439031';
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, set() { return this; }, send(body) { this.body = body; return this; } });

test('stock-derived availability permits replenished 1 HP and 3 HP options and retains explicit sales restrictions', () => {
  for (const capacity of ['1', '3']) {
    assert.equal(availability({ capacity, quantity: 5, status: 'out_of_stock' }).available, true);
    assert.equal(availability({ capacity, quantity: 0, status: 'in_stock' }).available, false);
  }
  for (const status of ['discontinued', 'coming_soon']) {
    assert.equal(availability({ quantity: 5, status }).available, false);
    assert.equal(availability({ quantity: 5 }, { status }).available, false);
  }
  assert.equal(availability({ quantity: 5 }, { active: false }).available, false);
  assert.equal(availability({ quantity: 5 }, { salesChannel: 'shop' }).available, false);
  assert.equal(availability({ quantity: 1, minStockLevel: 0 }).status, 'in_stock');
});

function cartFixture(options = {}) {
  const handlers = {}, roles = []; let saved = 0;
  const variant = { _id: id, capacity: '1', quantity: 5, status: 'in_stock', active: true, ...options.variant };
  class Cart {
    constructor(data) { Object.assign(this, data); }
    async save() { if (options.saveError) throw options.saveError; saved++; }
    static async findOne() { return options.currentQuantity ? new Cart({ items: [{ inventoryId: id, quantity: options.currentQuantity }] }) : null; }
  }
  const router = { use() {}, get() {}, delete() {}, post(route, handler) { handlers[route] = handler; } };
  vm.runInNewContext(read('routes/airconCartRoutes.js'), {
    module: { exports: {} }, console: { error() {} },
    require(name) {
      if (name === 'express') return { Router: () => router };
      if (name === 'mongoose') return mongoose;
      if (name === '../models/AirconCart') return Cart;
      if (name === '../models/Inventory') return { findById: async () => null };
      if (name === '../models/HVACProduct') return { findOne: () => ({ lean: async () => options.missing ? null : { active: true, salesChannel: 'both', variants: [variant], ...options.parent } }) };
      if (name === '../middleware/authenticate') return { authenticate() {}, requireRole(role) { roles.push(role); return () => {}; } };
      if (name === '../public/js/product-availability') return { availability };
      throw new Error('Unexpected dependency: ' + name);
    },
  });
  return { saved: () => saved, roles, async request(route, body = {}) { const res = response(); await handlers[route]({ user: { _id: userId }, body: { inventoryId: id, quantity: 1, ...body } }, res); return res; } };
}

test('cart and Buy Now resolve HVAC variant IDs, stock limits and unavailable states before saving', async () => {
  for (const route of ['/add', '/buy-now']) {
    for (const capacity of ['1', '3']) {
      const fixture = cartFixture({ variant: { capacity, status: 'out_of_stock', quantity: 5 } });
      const res = await fixture.request(route);
      assert.equal(res.statusCode, 200); assert.equal(fixture.saved(), 1); assert.deepEqual(fixture.roles, ['customer']);
    }
    for (const status of ['discontinued', 'coming_soon']) {
      const fixture = cartFixture({ variant: { status } }); const res = await fixture.request(route);
      assert.equal(res.statusCode, 409); assert.match(res.body.error, status === 'discontinued' ? /discontinued/i : /coming soon/i); assert.equal(fixture.saved(), 0);
    }
    const missing = cartFixture({ missing: true }); assert.equal((await missing.request(route)).statusCode, 404);
    for (const quantity of [true, [], {}, 1.5, 0, Number.MAX_SAFE_INTEGER + 1]) {
      const fixture = cartFixture(); assert.equal((await fixture.request(route, { quantity })).statusCode, 400); assert.equal(fixture.saved(), 0);
    }
    assert.equal((await cartFixture().request(route, { inventoryId: 'bad-id' })).statusCode, 400);
  }
  const existing = cartFixture({ currentQuantity: 5 }); const rejected = await existing.request('/add');
  assert.equal(rejected.statusCode, 409); assert.match(rejected.body.error, /already have 5.*add 0/i); assert.equal(existing.saved(), 0);
  assert.equal((await cartFixture({ currentQuantity: 5 }).request('/add', { quantity: -1 })).statusCode, 200);
  const uppercase = await cartFixture({ currentQuantity: 1 }).request('/add', { inventoryId:id.toUpperCase() });
  assert.equal(uppercase.statusCode, 200); assert.equal(uppercase.body.cart.items.length, 1); assert.equal(uppercase.body.cart.items[0].quantity, 2);
  const race = cartFixture({ saveError: Object.assign(new Error('race'), { name: 'VersionError' }) });
  assert.equal((await race.request('/add')).body.code, 'CART_CHANGED');
});

test('address selections must exist, belong together, and provide all required fields', async t => {
  const address = { addressProvince:'0304900000', addressCity:'0304901000', addressBarangay:'0304901030', addressPostal:'3100' };
  t.mock.method(catalog, 'getList', async kind => kind === 'provinces' ? [{ code: '0304900000', name: 'Nueva Ecija' }]
    : kind === 'cities' ? [{ code: '0304901000', name: 'Cabanatuan', province: 'Nueva Ecija' }, { code: '0305001000', name: 'Foreign City', province: 'Another Province' }]
      : [{ code: '0304901030', name: 'Sumacab Sur' }]);
  assert.deepEqual(await catalog.validateAddressSelection(address), { province:'Nueva Ecija', city:'Cabanatuan', barangay:'Sumacab Sur', postalCode:'3100' });
  assert.equal((await catalog.validateAddressSelection({ ...address, addressProvince:'Nueva Ecija', addressCity:'Cabanatuan', addressBarangay:'Sumacab Sur' })).city, 'Cabanatuan');
  for (const patch of [{ addressProvince:'FORGED' }, { addressCity:'0305001000' }, { addressBarangay:'FORGED' }, { addressBarangay:undefined }, { addressPostal:'1' }, { addressProvince:['Nueva Ecija'] }]) {
    await assert.rejects(catalog.validateAddressSelection({ ...address, ...patch }), error => error.status === 400 && Object.keys(error.fields).length > 0);
  }
});

test('address verification does not accept unchecked values during catalog outages', async t => {
  t.mock.method(catalog, 'getList', async () => { throw Object.assign(new Error('Unavailable'), { status: 503 }); });
  await assert.rejects(catalog.validateAddressSelection({ addressProvince:'P', addressCity:'C', addressBarangay:'B', addressPostal:'2009' }), error => error.status === 503);
});

test('registration rejects missing barangay, short postal codes, and object credentials', async () => {
  const { body, validationResult } = require('express-validator');
  const policy = require('../utils/registrationPasswordPolicy'); const source = read('routes/authRoutes.js');
  const start = source.indexOf('router.post(', source.indexOf('// Register - basic'));
  const end = source.indexOf('router.post(', start + 1); let validators;
  vm.runInNewContext(source.slice(start, end), { limitAuthWork: handler => handler, body, ...policy, authController: { register() {} }, router: { post(_path, list) { validators = list; } } });
  const req = { body: { email:['test@example.com'], password:{ value:'StrongPass1!' }, firstName:'Test', lastName:'Customer', phone:'09123456789', mathCaptcha:'2', mathAnswer:'2', addressProvince:'P', addressCity:'C', addressPostal:'1' } };
  for (const validator of validators) await validator.run(req);
  const fields = validationResult(req).array().map(e => e.path);
  for (const field of ['email', 'password', 'addressBarangay', 'addressPostal']) assert.ok(fields.includes(field));
});

test('unchanged profile returns informational status without updates or audit events', async t => {
  const User = require('../models/User'), audit = require('../utils/audit');
  const router = require('../routes/userRoutes'); const handler = router.stack.find(layer => layer.route?.path === '/me/profile').route.stack[0].handle;
  const user = { _id:userId, role:'customer', firstName:'Test', lastName:'Customer', phone:'09123456789', address:{ province:'P',city:'C',barangay:'B',postalCode:'2009' } };
  t.mock.method(User, 'findById', async () => user);
  const update = t.mock.method(User, 'findOneAndUpdate', async () => { throw new Error('Must not write'); });
  const events = t.mock.method(audit, 'logEvent', async () => { throw new Error('Must not audit a no-op'); });
  const res = response(); await handler({ user:{ _id:userId },body:{ firstName:' Test ',lastName:'Customer',phone:user.phone,address:{ ...user.address } } }, res, error => { throw error; });
  assert.equal(res.body.changed, false); assert.equal(res.body.message, 'No changes detected.'); assert.equal(update.mock.callCount(), 0); assert.equal(events.mock.callCount(), 0);
});

test('leave dates use Philippine today and reject previous years, rolled dates and invalid types', () => {
  const now = new Date('2026-10-13T16:30:00Z');
  assert.deepEqual(validateLeaveDates('2026-10-14', undefined, now).fields, {});
  for (const start of ['2025-01-01','2026-10-13','2027-02-30','2026-13-01',[],null]) assert.ok(validateLeaveDates(start, undefined, now).fields.startDate);
  assert.ok(validateLeaveDates('2026-10-15','2026-10-14',now).fields.endDate);
  assert.ok(validateLeaveDates('2026-10-15',0,now).fields.endDate);
});

function requestFixture(fetch) {
  const window = {};
  vm.runInNewContext(read('public/js/request-json.js'), { window, fetch, AbortController, setTimeout, clearTimeout, Error, TypeError });
  return window.RACSRequest;
}
test('API helper replaces gateway text and raw permission JSON while retaining validation fields', async () => {
  const gateway = requestFixture(async () => ({ ok:false,status:502,json:async () => JSON.parse('Bad Gateway') }));
  await assert.rejects(gateway.json('/test'), error => /temporarily unavailable/i.test(error.message) && !/token|json|Bad Gateway/i.test(error.message));
  const forbidden = requestFixture(async () => ({ ok:false,status:403,json:async () => ({ error:'Forbidden: insufficient permissions' }) }));
  await assert.rejects(forbidden.json('/test'), /do not have permission/);
  const validation = requestFixture(async () => ({ ok:false,status:400,json:async () => ({ error:'Check dates',fields:{ startDate:'Choose tomorrow' } }) }));
  await assert.rejects(validation.json('/test'), error => error.fields.startDate === 'Choose tomorrow');
  const network = requestFixture(async () => { throw new TypeError('fetch failed'); }); await assert.rejects(network.json('/test'), /connection/i);
  const timeout = requestFixture((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name:'AbortError' })))));
  await assert.rejects(timeout.json('/test', { timeoutMs:5 }), /took too long/);
});

test('invoice failure clears its loading state and offers retry instead of leaving an unresolved spinner', async () => {
  const source = read('views/pages/admin/Payments/Invoices.ejs'); const start = source.indexOf('let invoiceTotal='); const end = source.indexOf('function renderInvoices()', start);
  const nodes = new Map(); const node = id => { if (!nodes.has(id)) nodes.set(id, { value:'',innerHTML:'Loading…',setAttribute() {},removeAttribute() {},replaceChildren() {} }); return nodes.get(id); };
  const context = { RACSRequest:requestFixture(async () => ({ ok:false,status:502,json:async () => JSON.parse('Bad Gateway') })),document:{ getElementById:node },invoiceFooter:node('footer'),ie:String,AbortController,URLSearchParams,pageSize:10,renderPage() {} };
  vm.createContext(context); vm.runInContext(source.slice(start,end),context); await context.loadInvoices();
  assert.match(node('invoiceRows').innerHTML,/Retry/); assert.doesNotMatch(node('invoiceRows').innerHTML,/Loading|Unexpected token/);
});

test('invoice query validates pagination and filters then paginates in the database', () => {
  const collections = { payments:'payments',bookings:'bookingservices',orders:'orders',projects:'projects',pos:'walkinsales' };
  const { pipeline } = invoicePipeline(collections,{ page:'3',limit:'10',source:'Product Order',q:'[literal]' });
  assert.equal(pipeline.at(-1).$facet.invoices[1].$skip,30);
  assert.equal(pipeline.at(-1).$facet.invoices[2].$limit,10);
  assert.equal(pipeline.filter(stage => stage.$unionWith).length,3);
  assert.equal(pipeline.at(-2).$match.$or[0].invoiceNumber.$regex,'\\[literal\\]');
  for (const query of [{page:'NaN'},{page:'-1'},{limit:'201'},{source:'FORGED'}]) assert.throws(() => invoicePipeline(collections,query));
});

test('CSV template groups multiple HP rows into one product and rejects malformed or ambiguous inventory', async () => {
  const plan = await parseInventoryCsv(Buffer.from(csvTemplate()));
  assert.equal(plan.products.length,1); assert.equal(plan.products[0].variants.length,2); assert.deepEqual(plan.errors,[]);
  for (const [find, replacement] of [['split,true','FORGED,true'],[',20000,15000,5,',',-20,15000,5,'],[',40000,30000,3,',',40000,30000,1.5,'],[',3,HP,27000',',1,HP,27000']]) {
    const bad = await parseInventoryCsv(Buffer.from(csvTemplate().replace(find,replacement))); assert.ok(bad.errors.length > 0,find);
  }
  await assert.rejects(parseInventoryCsv(Buffer.from('wrong,headers\n1,2')),/headers/i);
  await assert.rejects(parseInventoryCsv(Buffer.alloc(1024*1024+1)),/1 MB/);
});

test('CSV review supports several models sharing a brand and category without executing a query twice', async t => {
  const Brand = require('../models/Brand'), Category = require('../models/Category'), HVACProduct = require('../models/HVACProduct');
  const router = require('../routes/hvacApi');
  const handler = router.stack.find(layer => layer.route?.path === '/hvac/import/preview').route.stack.at(-1).handle;
  const previous = process.env.JWT_SECRET; process.env.JWT_SECRET = 'csv-review-test-secret';
  t.after(() => { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
  let executions = 0;
  function query(record) {
    let executed = false;
    return { lean() { return this; }, then(resolve, reject) {
      if (executed) return Promise.reject(new Error('Query was already executed')).then(resolve, reject);
      executed = true; executions++;
      return Promise.resolve(record).then(resolve, reject);
    } };
  }
  const brands = t.mock.method(Brand, 'findOne', () => query({ _id: id, name: 'Sample Brand', active: true }));
  const categories = t.mock.method(Category, 'findOne', () => query({ _id: userId, name: 'Air Conditioner', active: true }));
  t.mock.method(HVACProduct, 'exists', async () => false);
  const lines = csvTemplate().trim().split(/\r?\n/);
  lines.push(lines[1].replace('Sample Model', 'Second Model'));
  const res = response();
  await handler({ user: { _id: userId }, file: { buffer: Buffer.from(lines.join('\n')) } }, res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body.errors, []);
  assert.equal(res.body.products.length, 2); assert.ok(res.body.previewToken);
  assert.equal(brands.mock.callCount(), 1); assert.equal(categories.mock.callCount(), 1); assert.equal(executions, 2);
});

test('bulk payroll validates employee selection, dates and template IDs', () => {
  const spec = { employeeIds:[id],templateIds:[],periodStart:'2026-10-01',periodEnd:'2026-10-07',payDate:'2026-10-08' };
  assert.equal(bulkPolicy.normalizeBatchRequest(spec).employeeIds.length,1);
  for (const patch of [{employeeIds:[]},{employeeIds:[id,id]},{employeeIds:['bad']},{periodStart:'2026-02-30'},{payDate:'2026-10-01'},{templateIds:['FORGED']},{employeeIds:Array(26).fill(id)}]) assert.throws(() => bulkPolicy.normalizeBatchRequest({...spec,...patch}));
  const data = { employee:id,compensationRecord:userId,basicPay:1000,netPay:1000,attendanceSummary:{present:1},calculationWarnings:[] };
  assert.notEqual(bulkPolicy.draftFingerprint(data),bulkPolicy.draftFingerprint({...data,attendanceSummary:{present:2}}));
});

test('bulk worker pool bounds database concurrency and preserves per-employee result order', async () => {
  let active=0,peak=0;
  const output = await bulkPolicy.mapLimited([1,2,3,4,5,6,7],async value => { active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,2));active--;return value*2; });
  assert.deepEqual(output,[2,4,6,8,10,12,14]); assert.equal(peak,3);
});

test('bulk payroll requires the same reviewed actor, selection and calculation before any draft is written', async () => {
  const jwt = require('jsonwebtoken');
  const source = read('routes/payrollRoutes.js');
  const begin = source.indexOf('async function payrollTemplates()'), end = source.indexOf('router.get("/:id/payslip"', begin);
  const handlers = {}; let changed = false, writes = 0;
  const secondId = '507f1f77bcf86cd799439022';
  const base = { employeeIds:[id,secondId],templateIds:[],periodStart:'2026-10-01',periodEnd:'2026-10-07',payDate:'2026-10-08' };
  const context = {
    process:{ env:{ JWT_SECRET:'bulk-test-secret' } },
    require(name) { if (name === 'jsonwebtoken') return jwt; throw new Error(name); },
    router:{ get() {},delete() {},patch() {},post(route,...callbacks) { handlers[route] = callbacks.at(-1); } },requireAdmin() {},
    bulkPolicy,PayrollTemplate:{ find:()=>({ sort:()=>({ lean:async()=>[] }) }) },
    User:{ findById:()=>({ select:()=>({ lean:async()=>({ firstName:'Test',lastName:'Employee' }) }) }) },
    async preparePayrollDraft(req) { return { employee:req.body.employee,compensationRecord:userId,basicPay:changed?2000:1000,netPay:changed?2000:1000,allowances:[],deductions:[],attendanceSummary:{ present:1 },calculationWarnings:[] }; },
    async createPayrollDraft(_req,data) { writes++; return { _id:id,netPay:data.netPay }; },
    withOperationLock:async (_key,work)=>work(),
  };
  vm.runInNewContext(source.slice(begin,end),context);
  const invoke = async (route,body,actor=userId) => { const res=response();await handlers[route]({ body,user:{ _id:actor } },res);return res; };
  const preview = await invoke('/bulk/preview',base); assert.equal(preview.body.ready,2);assert.equal(writes,0);
  const reviewed = {...base,previewToken:preview.body.previewToken};
  assert.equal((await invoke('/bulk/create',reviewed,id)).statusCode,409); assert.equal(writes,0);
  assert.equal((await invoke('/bulk/create',{...reviewed,payDate:'2026-10-09'})).statusCode,409); assert.equal(writes,0);
  changed=true;const stale=await invoke('/bulk/create',reviewed);assert.equal(stale.body.failed,2);assert.equal(writes,0);
  changed=false;const created=await invoke('/bulk/create',reviewed);assert.equal(created.body.created,2);assert.equal(writes,2);
});

test('CSV commit requires an unexpired preview tied to the same actor and exact file', async t => {
  const jwt = require('jsonwebtoken');const router=require('../routes/hvacApi');
  const handler=router.stack.find(layer=>layer.route?.path==='/hvac/import/commit').route.stack.at(-1).handle;
  const previous=process.env.JWT_SECRET;process.env.JWT_SECRET='csv-test-secret';t.after(()=>{if(previous===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=previous;});
  const buffer=Buffer.from(csvTemplate()),hash=require('node:crypto').createHash('sha256').update(buffer).digest('hex');
  const token=jwt.sign({purpose:'inventory-import',actor:userId,hash},process.env.JWT_SECRET,{expiresIn:60});
  for(const req of [
    {user:{_id:userId},body:{previewToken:'forged'},file:{buffer}},
    {user:{_id:id},body:{previewToken:token},file:{buffer}},
    {user:{_id:userId},body:{previewToken:token},file:{buffer:Buffer.from('changed')}},
  ]){const res=response();await handler(req,res);assert.equal(res.statusCode,409);}
});

test('successful password login records lastLogin together with its session', async t => {
  const User=require('../models/User'),LoginHistory=require('../models/LoginHistory'),AuthSession=require('../models/AuthSession');
  const secure=require('../controllers/secureAuthController');const rateLimiter=require('../middleware/loginRateLimiter');
  const previous=process.env.JWT_SECRET;process.env.JWT_SECRET='login-timestamp-test-secret';t.after(()=>{if(previous===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=previous;});
  const user={_id:userId,role:'customer',email:'test@example.com',active:true,emailVerified:true,lastLogin:new Date('2020-01-01'),comparePassword:async()=>true,async save(){assert.ok(this.lastLogin>new Date('2026-01-01'));}};
  t.mock.method(User,'findOne',async()=>user);t.mock.method(LoginHistory,'find',()=>({sort:()=>({limit:async()=>[]})}));t.mock.method(LoginHistory,'create',async()=>({suspicious:false}));t.mock.method(AuthSession,'create',async()=>{});
  t.mock.method(rateLimiter,'isBlocked',()=>({blocked:false}));t.mock.method(rateLimiter,'reset',()=>{});
  const start=Date.now();let finish;const done=new Promise(resolve=>{finish=resolve;});
  const res=response();res.cookie=()=>res;res.json=function(body){this.body=body;finish();return this;};
  const req={body:{email:user.email,password:'Password1!',mathCaptcha:'2',mathAnswer:'2',csrfToken:'fixture'},headers:{cookie:'XSRF-TOKEN=fixture',accept:'application/json'},ip:'127.0.0.1',connection:{},sessionID:'fixture',session:{cookie:{},regenerate(cb){cb();}}};
  signedRequest(req, "login");await secure.login(req,res,error=>{throw error;});await done;
  assert.equal(res.body.ok,true);assert.ok(user.lastLogin.getTime()>=start);assert.ok(user.currentSessionId);
});

test('repair assignment saves promptly without waiting for optional external AI recommendations', async () => {
  const source=read('routes/appointmentManagement.js');const begin=source.indexOf("router.post('/:id/assign'");const end=source.indexOf("router.get('/:id/ai-recommendations'",begin);
  const statuses=require('../models/BookingStatus').BookingStatus;const dates=require('../utils/bookingDateTime');
  let handler,aiCalls=0,saved=0;
  const booking={_id:id,bookingReference:'DEMO',status:statuses.AWAITING_ASSIGNMENT,serviceModel:'RepairService',serviceType:'repair',services:[{type:'repair',name:'Inspection'}],customer:{name:'Test'},bookingDate:new Date('2026-10-20'),startTime:'',endTime:'',async save(){saved++;},recordStatusHistory(){}};
  class Assignment{constructor(data){Object.assign(this,data);this._id=userId;this.notes=[];}async save(){}}
  const technician={_id:userId,user:id,name:'Technician'};
  const technicians={findById(){const query=Promise.resolve(technician);query.lean=async()=>technician;return query;},findByIdAndUpdate:async()=>{}};
  vm.runInNewContext(source.slice(begin,end),{
    router:{post(_path,_role,fn){handler=fn;}},requireRole:()=>()=>{},BookingService:{findById:async()=>booking},BookingStatus:statuses,Assignment,
    isAssignmentWindowExpired:()=>false,manilaDateKey:dates.manilaDateKey,manilaDateTime:dates.manilaDateTime,
    generateRepairRecommendations:async()=>{aiCalls++;throw new Error('Slow external provider');},console:{log(){},error(){}},
    require(name){if(name==='../utils/assignmentPlanner')return{buildAssignmentPlan:async()=>[{candidates:[{technicianId:userId,name:'Technician'}]}]};if(name==='../models/Technician')return technicians;if(name==='../utils/availability')return{resolveAvailabilityStatus:async()=> 'Assigned'};if(name==='../utils/notify')return{createNotification:async()=>{}};if(name==='../models/User')return{findById:()=>({lean:async()=>null})};if(name==='../utils/mailer')return{};throw new Error(name);},
  });
  const res=response();await handler({params:{id},body:{technicianId:userId},user:{_id:id,name:'Admin'},app:{get(){return null;}}},res);
  assert.equal(res.statusCode,200);assert.equal(res.body.success,true);assert.equal(saved,1);assert.equal(aiCalls,0);assert.equal(booking.status,statuses.INSPECTION_SCHEDULED);
});

test('PDF export creates complete multipage documents from server analytics and rejects missing reports', async () => {
  const { buildReportPdf } = require('../utils/reportPdf');
  const buffer = await buildReportPdf('orders',{ totalOrders:80,grossRevenue:12000,reportStart:'2026-10-01',reportEnd:'2026-10-14',recentOrders:Array.from({length:80},(_,i)=>({reference:'ORDER-'+i,customer:'Test customer',amount:150,status:'completed'})) },{ from:'2026-10-01',to:'2026-10-14' });
  assert.ok(buffer.subarray(0,5).equals(Buffer.from('%PDF-'))); assert.match(buffer.subarray(-50).toString(),/%%EOF/);
  assert.ok((buffer.toString('latin1').match(/\/Type \/Page\b/g)||[]).length>1);
  await assert.rejects(buildReportPdf('orders',null),/load successfully/);
});
