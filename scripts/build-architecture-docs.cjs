/* Build self-contained, offline architecture visuals from audited diagram definitions. */
const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname, '../docs/architecture');
const audit = JSON.parse(fs.readFileSync(path.join(dir,'audit-inventory.json'),'utf8'));
const groups = [
  ['D1','Identity and access','User Role AuthSession TrustedDevice LoginHistory FailedLoginAttempt Technician Secretary'],
  ['D2','Service and product catalog','CoreService RepairService Service ServiceCategory HVACProduct Brand Category'],
  ['D3','Bookings and dispatch','BookingService Assignment TechnicianSchedule NonWorkingDay UnitAssistanceRequest RelocationRequest ServiceReport'],
  ['D4','Stock and field equipment','Inventory Tool ToolAssignment StockReservation StockAdjustment ServiceToolUsage EquipmentAssignment EquipmentUsageLog DailyKit PartsRequest'],
  ['D5','Projects and work orders','Project WorkOrder DailyAssignment ProjectMaterial ProjectIssue ProjectResourcePurchase ProjectWorkSubmission'],
  ['D6','Sales and carts','AirconCart Order Purchase WalkInSale'],
  ['D7','Finance and compensation','Payment Payroll Expense EmployeeCompensation'],
  ['D8','Aftercare and feedback','CustomerAsset MaintenanceSchedule WarrantyClaim ProductReturn ProductRefund ProductReturnMovement Rating'],
  ['D9','Attendance and leave','TechnicianAttendance SecretaryAttendance LeaveRequest'],
  ['D10','Configuration and communication','SiteSetting ActivityLog Notification EmailOutbox EmailDeliveryLog OperationLock'],
];
const grouped = groups.flatMap(g=>g[2].split(' '));
if (new Set(grouped).size !== audit.models.length || audit.models.some(m=>!grouped.includes(m.name))) throw new Error('Every model must be assigned to exactly one logical store');
const node = (id,label,x,y,type='component',w=280,h=90) => ({id,label,x,y,type,w,h});
const edge = (from,to,label,offset=0) => ({from,to,label,offset});
const diagrams = [];
diagrams.push({id:'dfd-context',title:'DFD — context (Level 0)',description:'The complete application is one process. Actors and external services exchange named data with it; MongoDB is internal and is omitted at this level.',width:1480,height:900,nodes:[
  node('customer','Customer / visitor',40,150,'entity'),node('admin','Administrator',40,340,'entity'),node('secretary','Secretary / dispatcher',40,530,'entity'),node('tech','Technician',40,720,'entity'),
  node('p0','0. CALIDRO RACS\nWeb management system',590,430,'process',300,130),
  node('identity','Google identity / reCAPTCHA',1160,150,'entity'),node('payment','PayMongo\nRetained gateway / webhook',1160,310,'entity'),node('mail','Brevo API / SMTP',1160,470,'entity'),node('geo','Location / calendar providers\nPSGC, Geoapify, Nominatim\nOSRM, Esri, Google, Nager',1160,640,'entity',280,120),node('ai','Gemini / Groq / OpenRouter\nTavily search',1160,790,'entity'),
],edges:[
  edge('customer','p0','Account, booking, order, proof, claim',-16),edge('p0','customer','Catalog, quote, receipt, status, answer',16),
  edge('admin','p0','Approval, pricing, role, settings',-16),edge('p0','admin','Queues, reports, audit, alerts',16),
  edge('secretary','p0','Dispatch, POS, payment review',-16),edge('p0','secretary','Work queues, schedules, reports',16),
  edge('tech','p0','Job response, GPS, evidence, attendance',-16),edge('p0','tech','Assignments, kit, payslip, alerts',16),
  edge('p0','identity','OAuth / challenge verification',-16),edge('identity','p0','Identity / challenge result',16),
  edge('payment','p0','Signed payment events'),edge('p0','payment','Source charge request, if used',-25),edge('p0','mail','Transactional message'),edge('mail','p0','Delivery response',25),
  edge('p0','geo','Address, coordinates, event, holiday query',-16),edge('geo','p0','Location, route, event ID, holiday data',16),
  edge('p0','ai','Question / conversation / search terms',-16),edge('ai','p0','Answer / search evidence',16),
]});
diagrams[0].height=1090;
diagrams[0].nodes.push(node('cloud','Cloudinary product images',1160,950,'entity'));
diagrams[0].edges.push(edge('p0','cloud','Product image / deletion request',-16),edge('cloud','p0','Image URL / upload result',16));
const processes = [
  ['1.0 Identity and access','Customer / staff','Credentials, OTP, OAuth response','Access result, profile, session','D1'],
  ['2.0 Catalog and pricing','Customer / administrator','Catalog query, catalog changes','Service / product details, prices','D2'],
  ['3.0 Booking and dispatch','Customer / dispatch / technician','Booking, quote choice, job response','Availability, quote, assignment, status','D3'],
  ['4.0 Inventory and field resources','Administrator / secretary / technician','Stock entry, kit, usage, return','Stock, reservations, equipment ledger','D4'],
  ['5.0 Project delivery','Administrator / secretary / technician','Project plan, materials, work report','Work orders, resource plan, progress','D5'],
  ['6.0 Sales and fulfillment','Customer / administrator / secretary','Cart, checkout, POS, delivery update','Order, receipt, fulfillment status','D6'],
  ['7.0 Finance and payroll','Customer / staff','Proof, payment review, remittance','Payment result, refund, payroll result','D7'],
  ['8.0 Aftercare and feedback','Customer / staff','Asset, maintenance, warranty, return, rating','Coverage, follow-up, claim / return result','D8'],
  ['9.0 Attendance and leave','Technician / secretary / administrator','Attendance, leave, approval','Attendance / leave result','D9'],
  ['10.0 Reports, settings and assistance','Customer / staff','Report query, settings, chat question','Report, settings result, AI answer, alerts','D10'],
];
diagrams.push({id:'dfd-level-1',title:'DFD — system decomposition (Level 1)',description:'Ten logical processes and ten logical MongoDB stores cover all 63 models. Repeated actor boxes are aliases. Detailed store reads and cross-process flows are listed in README.md; providers are decomposed in the context and Level 2 diagrams.',width:1500,height:1830,nodes:processes.flatMap((p,i)=>[
  node('actor'+i,p[1],35,140+i*165,'entity',300,100),node('p'+(i+1),p[0],580,140+i*165,'process',320,100),node(p[4],p[4]+'. '+groups[i][1],1170,140+i*165,'store',300,100),
]),edges:processes.flatMap((p,i)=>[
  edge('actor'+i,'p'+(i+1),p[2],-18),edge('p'+(i+1),'actor'+i,p[3],18),edge(p[4],'p'+(i+1),'Stored records',18),edge('p'+(i+1),p[4],'New / changed records',-18),
])});
const levelOne=diagrams[1];
levelOne.width=1970;levelOne.height=2100;
levelOne.description='Ten processes and ten logical MongoDB model stores cover all 63 models. D11 and D12 represent additional proof storage and runtime state. Repeated actor boxes are aliases. Provider exchanges balance the context diagram; cross-process contracts and additional store reads are listed in README.md.';
const providers=[
  ['identity1','Google OAuth / reCAPTCHA',0,'p1','Identity / verification result','OAuth / challenge request'],
  ['cloud1','Cloudinary',1,'p2','Image URL / upload result','Product image / deletion'],
  ['geo1','Maps / addresses / calendars\nPSGC, Geoapify, Nominatim, OSRM\nEsri, Google, Nager.Date',2,'p3','Location / route / calendar data','Address / route / event query'],
  ['gateway1','PayMongo retained gateway',6,'p7','Signed payment event','Optional source charge'],
  ['ai1','Gemini / Groq / OpenRouter\nTavily search',8,'p10','Answer / search result','Question / search terms'],
  ['mail1','Brevo API / SMTP',9,'p10','Delivery result','Transactional email'],
];
for(const [id,label,row,process,input,output] of providers){levelOne.nodes.push(node(id,label,1630,140+row*165,'entity',300,100));levelOne.edges.push(edge(process,id,output,-18),edge(id,process,input,18));}
levelOne.nodes.push(node('d11','D11 GridFS proofs\npaymentProofs / completionProofs',35,1860,'store',340,110),node('d12','D12 Runtime / local storage\nChat history, caches, temp uploads\nLegacy files, logs',1170,1860,'store',340,110));
levelOne.edges.push(edge('p3','d11','Completion images',-30),edge('d11','p3','Authorized completion evidence',30),edge('p7','d11','Payment proof images',-18),edge('d11','p7','Authorized payment evidence',18),edge('p10','d12','Chat / cache state and logs',-18),edge('d12','p10','Cached data / chat context',18));
diagrams.push({id:'dfd-booking-level-2',title:'DFD — booking and field service (Level 2 of 3.0)',description:'Decomposes booking submission, review, dispatch and execution. Payment confirmation is an input from 7.0; resource usage belongs to 4.0. Repair quotations and custom-unit / relocation requests use the same booking domain.',width:1500,height:1160,nodes:[
  node('customer','Customer',35,180,'entity'),node('dispatch','Administrator / secretary',35,480,'entity'),node('tech','Technician',35,800,'entity'),node('finance','7.0 Finance',35,1040,'process'),
  node('p31','3.1 Quote and capacity check',590,180,'process',330),node('p32','3.2 Persist booking submission',590,380,'process',330),node('p33','3.3 Review and assign work',590,600,'process',330),node('p34','3.4 Execute / reschedule / complete',590,820,'process',330),node('p35','3.5 Publish work outcome',590,1040,'process',330),
  node('d2','D2 Service catalog',1160,180,'store'),node('d3','D3 Bookings / schedules\nQuotes / assignments / reports',1160,380,'store'),node('resources','4.0 Inventory / kits / usage',1160,600,'process'),node('proof','D11 GridFS completionProofs',1160,820,'store'),node('notice','10.0 Alerts / 8.0 aftercare',1160,1040,'process'),
],edges:[edge('customer','p31','Service, units, address, preferred date'),edge('d2','p31','Price / duration / service rules'),edge('d3','p31','Schedules, holidays, quote records',18),edge('p31','customer','Quote, availability, validation',20),edge('p31','p32','Validated submission'),edge('p32','d3','Booking / quote conversion'),edge('p32','finance','Pending payment request',30),edge('finance','p33','Payment review outcome',-22),edge('dispatch','p33','Review / technician selection'),edge('d3','p33','Booking / capacity / assignment'),edge('p33','d3','Review and assignment changes',20),edge('p33','tech','Assigned job details',-22),edge('tech','p34','Acceptance, GPS, report, photos'),edge('p34','resources','Parts, kit and usage records'),edge('p34','proof','Validated completion images'),edge('p34','d3','Job status / service report',-20),edge('p34','p35','Confirmed work outcome'),edge('p35','notice','Notification / eligible aftercare event'),edge('p35','customer','Booking status / completion result',-30)]});
diagrams.push({id:'dfd-sales-level-2',title:'DFD — sales and payment (Level 2 of 6.0 / 7.0)',description:'Product checkout decrements Inventory or HVACProduct variant stock conditionally. Tool StockReservation records belong to field resources. Online card checkout is retired; signed gateway events remain handled by the code.',width:1500,height:1060,nodes:[
  node('customer','Customer / POS staff',35,180,'entity'),node('review','Administrator / secretary',35,500,'entity'),node('tech','Technician / collection staff',35,790,'entity'),
  node('p61','6.1 Select cart / POS items',580,180,'process',340),node('p62','6.2 Commit order and stock',580,370,'process',340),node('p71','7.1 Store / review payment',580,590,'process',340),node('p72','7.2 Collect and reconcile',580,810,'process',340),
  node('catalog','D2 HVACProduct / D4 Inventory',1170,180,'store'),node('sales','D6 AirconCart / Order / WalkInSale',1170,370,'store'),node('ledger','D7 Payment',1170,590,'store'),node('proof','D11 GridFS paymentProofs',1170,810,'store'),node('gateway','PayMongo signed webhook',35,980,'entity'),node('notice','10.0 Receipt / notification',580,980,'process',340),node('refund','8.0 Return / refund workflow',1170,980,'process'),
],edges:[edge('customer','p61','Selected items / quantities'),edge('catalog','p61','Product, variant, price, availability'),edge('p61','p62','Validated checkout and request ID'),edge('p62','catalog','Conditional stock decrement',-20),edge('p62','sales','Order and cart changes'),edge('p62','p71','Order-linked pending payment'),edge('customer','p71','Proof / reference / chosen method',-25),edge('review','p71','Verification / rejection'),edge('p71','ledger','Payment state and event history'),edge('p71','proof','Validated receipt image',-20),edge('tech','p72','Collection / remittance details'),edge('gateway','p72','Verified provider event'),edge('p72','ledger','Financial event / reconciliation'),edge('p72','sales','Paid / preparing-unit state',20),edge('p72','notice','Receipt / status message'),edge('notice','customer','Order / payment outcome',-30),edge('refund','ledger','Refund accounting updates'),edge('ledger','refund','Original payment evidence',20)]});
diagrams.push({id:'web-architecture',title:'Web architecture — request and response path',description:'EJS executes on the server. The browser receives HTML, CSS and JavaScript, then uses JSON APIs, SSE chat and Socket.IO. All backend components share one Node.js process.',width:1540,height:1180,nodes:[
  node('browser','Browser\nCustomer / admin / secretary / technician',45,170,'entity',350,110),node('providers','Browser map / identity assets\nEsri tiles, Google / reCAPTCHA\nOSRM route display, optional QR service',45,440,'entity',350,120),
  node('proxy','Hosting HTTPS reverse proxy\nRender configuration',590,170,'component',360,100),node('public','Fast paths\nPublic assets + /health + /ready',590,350,'component',360,100),node('security','Express request middleware\nAdmission, origin, body limits, session\nCurrent user, API budgets, RBAC',590,560,'component',360,120),node('routes','Page and API routers\nDomain policies / controllers / utilities',590,780,'component',360,100),node('views','Server-side EJS renderer\nHTML response + browser scripts',590,1010,'component',360,100),
  node('mongo','MongoDB\nDomain data + connect-mongo sessions',1180,560,'store',310,100),node('socket','Socket.IO gateway\nAuthenticated rooms / GPS events',1180,170,'component',310,110),node('webhook','Raw PayMongo webhook\nSignature checked before JSON parsing',1180,350,'component',310,100),node('sse','Chat response / SSE stream\nAI provider adapters',1180,780,'component',310,100),node('storage','Protected GridFS proof downloads\nPublic Cloudinary product images',1180,1010,'store',310,110),
],edges:[edge('browser','proxy','HTTPS page / API request'),edge('proxy','browser','HTML / JSON / assets',20),edge('proxy','public','Static file / probe'),edge('proxy','security','Application request',-25),edge('security','mongo','Session / user / permissions'),edge('security','routes','Authenticated / allowed request'),edge('routes','mongo','Mongoose reads and writes',20),edge('routes','views','Template and view data'),edge('views','browser','Rendered HTML',-28),edge('browser','socket','Socket transport / GPS',-22),edge('socket','browser','Scoped notifications / location',22),edge('webhook','mongo','Verified gateway event processing'),edge('routes','sse','Chat question'),edge('sse','browser','Answer / streamed tokens',30),edge('routes','storage','Authorized upload / download'),edge('browser','providers','Tiles / routing / challenges',-20),edge('providers','browser','Map data / identity UI assets',20)]});
diagrams.push({id:'system-architecture',title:'System architecture — deployed containers and components',description:'Observed deployment: one Node web service plus MongoDB and external providers. Timers, caches, web sockets and domain modules are components of that service, rather than independently deployed services.',width:1540,height:1220,nodes:[
  node('actors','Four browser personas',40,170,'entity',300),node('edge','HTTPS hosting proxy\nrender.yaml / readiness probe',580,170,'component',360),node('app','Node.js / Express 5 web process\nEJS, middleware, domain routes',580,390,'component',360,110),
  node('domain','Business components\nBookings, sales, stock, projects\nFinance, staff, aftercare, reporting',580,620,'component',360,120),node('workers','In-process background workers\nEmail outbox, overdue, maintenance\nEquipment return, delay, reminders',580,860,'component',360,130),node('local','Process memory / local filesystem\nRate budgets, caches, chat sessions\nTemporary + legacy uploads / logs',580,1090,'store',360,120),
  node('db','MongoDB shared database\n63 model collections + sessions\nGridFS payment / completion buckets',1190,390,'store',310,130),node('images','Cloudinary\nPublic product image storage',1190,620,'entity',310),node('services','External adapters\nGoogle OAuth / reCAPTCHA / Calendar\nBrevo / SMTP, maps / holidays\nGemini / Groq / OpenRouter / Tavily',1190,860,'entity',310,150),node('gateway','PayMongo\nRetained gateway processing',1190,1090,'entity',310),node('realtime','Socket.IO + chat SSE\nSame HTTP server',40,620,'component',300,100),node('admin','Admin / secretary reports\nRevenue and decision analytics',40,860,'entity',300,100),
],edges:[edge('actors','edge','HTTPS'),edge('edge','app','HTTP / socket forwarding'),edge('app','domain','Authorized request'),edge('domain','db','Models / sessions / proof bytes'),edge('app','db','Shared Mongo client',20),edge('domain','images','Product image upload / delete'),edge('domain','services','Provider requests / responses'),edge('app','workers','Startup after database ready'),edge('workers','db','Polling, claims, state changes',20),edge('workers','services','Email / notification delivery'),edge('app','local','Bounded state / file access',-28),edge('gateway','app','Raw signed payment event',-25),edge('domain','gateway','Optional retained source charge',25),edge('domain','realtime','Room events / chat tokens'),edge('realtime','actors','Live browser updates'),edge('domain','admin','Reports from operational records')]});
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function wrap(text,width=31) {
  return text.split('\n').flatMap(line=>{
    const result=[]; let current='';
    for (const word of line.split(' ')) { if (current && current.length+word.length+1>width) { result.push(current); current=word; } else current+=(current?' ':'')+word; }
    result.push(current); return result;
  });
}
function svg(d) {
  const byId = new Map(d.nodes.map(n=>[n.id,n]));
  const colors={entity:['#fff7ed','#c2410c'],process:['#eff6ff','#1d4ed8'],store:['#ecfdf5','#047857'],component:['#f5f3ff','#6d28d9']};
  const arrows=d.edges.map(e=>{
    const a=byId.get(e.from),b=byId.get(e.to);
    if (!a||!b) throw new Error('Invalid graph endpoint '+JSON.stringify(e));
    const dx=b.x-a.x,dy=b.y-a.y; let x1=a.x+a.w/2,y1=a.y+a.h/2,x2=b.x+b.w/2,y2=b.y+b.h/2;
    const vertical=Math.abs(dx)<100;
    let curve; let labelPoint;
    if (vertical) { y1+=dy>=0?a.h/2:-a.h/2;y2+=dy>=0?-b.h/2:b.h/2; x1+=e.offset;x2+=e.offset;curve=`M ${x1} ${y1} C ${x1+e.offset} ${(y1+y2)/2}, ${x2+e.offset} ${(y1+y2)/2}, ${x2} ${y2}`; }
    else {
      x1+=dx>=0?a.w/2:-a.w/2;x2+=dx>=0?-b.w/2:b.w/2;y1+=e.offset;y2+=e.offset;
      // Route same-row provider flows around intervening store boxes.
      const blocked=Math.abs(dy)<30 && d.nodes.some(n=>n.id!==a.id&&n.id!==b.id&&n.x>Math.min(x1,x2)&&n.x+n.w<Math.max(x1,x2)&&n.y<=y1&&n.y+n.h>=y1);
      if(blocked){const lane=e.offset<0?Math.min(a.y,b.y)-42:Math.max(a.y+a.h,b.y+b.h)+42;curve=`M ${x1} ${y1} L ${x1+(dx>=0?20:-20)} ${lane} L ${x2-(dx>=0?20:-20)} ${lane} L ${x2} ${y2}`;labelPoint=[(x1+x2)/2,lane-7];}
      else curve=`M ${x1} ${y1} C ${(x1+x2)/2} ${y1}, ${(x1+x2)/2} ${y2}, ${x2} ${y2}`;
    }
    const lx=labelPoint?.[0]??(x1+x2)/2+(vertical?90:0),ly=labelPoint?.[1]??(y1+y2)/2-7;
    const lines=wrap(e.label,35);
    return `<g><path d="${curve}" fill="none" stroke="#64748b" stroke-width="1.5" marker-end="url(#arrow)"/><text x="${lx}" y="${ly}" text-anchor="middle" font-size="12" fill="#334155" stroke="white" stroke-width="5" paint-order="stroke">${lines.map((l,i)=>`<tspan x="${lx}" dy="${i?15:0}">${esc(l)}</tspan>`).join('')}</text></g>`;
  }).join('');
  const boxes=d.nodes.map(n=>{
    const [fill,stroke]=colors[n.type]; const lines=wrap(n.label,Math.floor(n.w/8));
    return `<g><title>${esc(n.label)}</title><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${n.type==='process'?28:n.type==='entity'?0:10}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>${n.type==='store'?`<path d="M ${n.x+12} ${n.y} V ${n.y+n.h}" stroke="${stroke}" stroke-width="2"/>`:''}<text x="${n.x+n.w/2}" y="${n.y+n.h/2-(lines.length-1)*10+5}" text-anchor="middle" fill="#0f172a" font-size="15" font-weight="600">${lines.map((l,i)=>`<tspan x="${n.x+n.w/2}" dy="${i?20:0}">${esc(l)}</tspan>`).join('')}</text></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title description" viewBox="0 0 ${d.width} ${d.height}" width="${d.width}" height="${d.height}" font-family="Arial, sans-serif"><title id="title">${esc(d.title)}</title><desc id="description">${esc(d.description)}</desc><defs><marker id="arrow" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto"><path d="M0 0 L9 3.5 L0 7 Z" fill="#64748b"/></marker></defs><rect width="100%" height="100%" fill="white"/><text x="35" y="42" font-size="25" font-weight="700" fill="#0f172a">${esc(d.title)}</text><text x="35" y="70" font-size="13" fill="#475569">CALIDRO RACS · Repository audit: 09 October 2026 · Arrows name data or communication flows</text>${arrows}${boxes}</svg>`;
}
function mermaid(d) {
  return ['flowchart TB',...d.nodes.map(n=>{
    const label=n.label.replace(/\n/g,'<br/>').replace(/"/g,'&quot;');
    return `  ${n.id}${n.type==='process'?'(["'+label+'"])':n.type==='store'?'[("'+label+'")]':'["'+label+'"]'}`;
  }),...d.edges.map(e=>`  ${e.from} -->|"${e.label.replace(/"/g,'&quot;')}"| ${e.to}`),''].join('\n');
}
fs.mkdirSync(path.join(dir,'diagrams'),{recursive:true});
for (const d of diagrams) {
  fs.writeFileSync(path.join(dir,'diagrams',d.id+'.svg'),svg(d));
  fs.writeFileSync(path.join(dir,'diagrams',d.id+'.mmd'),mermaid(d));
}
const relationships = ['flowchart LR',...audit.models.map(m=>`  ${m.name}["${m.name}"]`),
  ...audit.models.flatMap(m=>[...new Set(m.references.filter(r=>r.ref && audit.models.some(t=>t.name===r.ref)).map(r=>r.ref))].map(ref=>`  ${m.name} --> ${ref}`)),
  '  MissingProduct["Product: unregistered target"]','  Purchase -.-> MissingProduct',
  '  classDef missing fill:#fff1f2,stroke:#be123c;', '  class MissingProduct missing;', ''];
fs.writeFileSync(path.join(dir,'diagrams','model-references.mmd'),relationships.join('\n'));
const graphDoc = ['# Data flow and architecture diagrams','', 'Generated with `node scripts/build-architecture-docs.cjs`. SVG files render offline. Mermaid files remain editable. The SVG layouts and Mermaid layouts share nodes and edges; their positions differ.','',...diagrams.flatMap(d=>[
  `## ${d.title}`,'',d.description,'',`[Download SVG](diagrams/${d.id}.svg) · [Mermaid source](diagrams/${d.id}.mmd)`,'','```mermaid',mermaid(d),'```','',
]),'## All model references','', 'Static references only; arrows point from a referencing model to its target. Cardinalities and foreign-key enforcement are not implied. Dynamic refPath relationships are detailed in MODEL_AUDIT.md.','', '[Full model graph](diagrams/model-references.mmd)','','```mermaid',relationships.join('\n'),'```',''];
fs.writeFileSync(path.join(dir,'DIAGRAMS.md'),graphDoc.join('\n'));
const testLogPath=path.resolve(__dirname,'../temp/architecture-audit-tests.log');
let testSummary='Tests not recorded'; let failed=[];
if(fs.existsSync(testLogPath)) {
  const logBytes=fs.readFileSync(testLogPath);
  const log=logBytes.toString(logBytes[0]===0xff && logBytes[1]===0xfe ? 'utf16le' : 'utf8').replace(/^\uFEFF/,'');
  const totals=[...log.matchAll(/ℹ (tests|pass|fail|cancelled|skipped|duration_ms) ([\d.]+)/g)].map(m=>`${m[1]}: ${m[2]}`);
  testSummary=totals.join(' · ');
  const failures=log.split('✖ failing tests:')[1]||'';
  failed=[...failures.matchAll(/test at ([^\r\n]+)\r?\n✖ ([^\r\n]+)/g)].map(m=>({location:m[1].replace(/\\/g,'/'),name:m[2].replace(/ \([\d.]+ms\)$/,'')}));
  fs.writeFileSync(path.join(dir,'test-results.json'),JSON.stringify({command:'node server/tests/run-all.js',auditedOn:audit.auditedOn,summary:testSummary,failures:failed},null,2)+'\n');
}
const rows=audit.models.map(m=>{
  const g=groups.find(g=>g[2].split(' ').includes(m.name));
  return `<tr><td><a href="../../${m.file}">${esc(m.name)}</a></td><td>${esc(g[0]+' '+g[1])}</td><td>${esc(m.collection)}</td><td>${m.fields.length}</td><td>${m.indexes.length}</td><td>${esc([...new Set(m.references.map(r=>r.ref||'dynamic: '+r.refPath))].join(', '))}</td></tr>`;
}).join('');
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CALIDRO RACS — audited architecture</title><style>
*{box-sizing:border-box}body{margin:0;background:#f1f5f9;color:#0f172a;font:15px/1.6 Arial,sans-serif}header{background:#0f172a;color:white;padding:40px max(24px,5vw)}h1{font-size:32px;line-height:1.2;margin:8px 0 14px}header p{max-width:900px;color:#cbd5e1}header a{color:#93c5fd}.tag{font-size:12px;letter-spacing:2px;color:#93c5fd}.stats{display:flex;gap:12px;flex-wrap:wrap}.stats span{padding:8px 14px;background:#1e293b;border-radius:8px}nav{position:sticky;top:0;z-index:2;display:flex;gap:8px;flex-wrap:wrap;background:white;padding:14px 5vw;border-bottom:1px solid #cbd5e1}nav button,button,.download{border:1px solid #cbd5e1;background:white;padding:9px 14px;border-radius:6px;color:#1e293b;cursor:pointer;font:inherit}nav button[aria-selected=true]{color:white;background:#1d4ed8;border-color:#1d4ed8}main{max-width:1700px;padding:28px 4vw;margin:auto}section{background:white;border:1px solid #cbd5e1;padding:24px;border-radius:12px;margin-bottom:20px}section[hidden]{display:none}h2{margin:0 0 10px;font-size:24px}.desc{max-width:1100px;color:#475569}.tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:18px 0}.download{text-decoration:none;font-size:14px}.canvas{border:1px solid #e2e8f0;overflow:auto;background:white;border-radius:8px}.canvas svg{display:block;width:100%;height:auto;min-width:1000px}.legend{display:flex;gap:20px;flex-wrap:wrap;font-size:13px;margin-top:14px}.legend span:before{content:'';display:inline-block;width:14px;height:14px;border:2px solid;margin-right:7px;vertical-align:middle}.legend .entity:before{color:#c2410c;background:#fff7ed}.legend .process:before{color:#1d4ed8;background:#eff6ff;border-radius:9px}.legend .store:before{color:#047857;background:#ecfdf5}.legend .component:before{color:#6d28d9;background:#f5f3ff}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:11px;border-bottom:1px solid #e2e8f0;vertical-align:top}th{background:#f8fafc}input[type=search]{padding:10px 14px;border:1px solid #94a3b8;border-radius:6px;width:min(100%,450px)}a{color:#1d4ed8}.finding{border-left:4px solid #d97706;padding:12px 16px;background:#fffbeb;margin:12px 0}.finding strong{display:block}.small{font-size:13px;color:#64748b}footer{padding:24px 5vw;color:#475569}@media print{nav,.tools,footer{display:none}section[hidden]{display:block}section{break-before:page;border:0;padding:0}.canvas{overflow:visible;border:0}.canvas svg{min-width:0;width:100%}header{background:white;color:black;padding:0}header p{color:#334155}main{padding:0}.stats{display:none}a{color:black}}
</style></head><body><header><div class="tag">CALIDRO RACS / SOURCE AUDIT</div><h1>Data flow, web architecture<br>and system architecture</h1><p>Based on the current repository and all compiled data models. Audited 09 October 2026. The application runs as one Express/EJS service with MongoDB, Socket.IO and in-process background workers.</p><div class="stats"><span>63 Mongoose models</span><span>38 route modules</span><span>139 utility modules</span><span>197 test files</span></div><p><a href="README.md">Architecture report</a> · <a href="AUDIT_FINDINGS.md">Audit findings</a> · <a href="MODEL_AUDIT.md">Every model and field</a></p></header><nav aria-label="Architecture views" role="tablist">${diagrams.map((d,i)=>`<button role="tab" id="tab-${d.id}" aria-controls="${d.id}" aria-selected="${i===0}" data-view="${d.id}">${esc(d.title.replace(/ — .*/,''))}${d.id==='dfd-level-1'?' Level 1':d.id.includes('level-2')?' '+(d.id.includes('booking')?'Booking':'Sales'):''}</button>`).join('')}<button role="tab" id="tab-models" aria-controls="models" aria-selected="false" data-view="models">Models &amp; findings</button></nav><main>${diagrams.map((d,i)=>`<section role="tabpanel" aria-labelledby="tab-${d.id}" id="${d.id}" ${i?'hidden':''}><h2>${esc(d.title)}</h2><p class="desc">${esc(d.description)}</p><div class="tools"><a class="download" href="diagrams/${d.id}.svg" download>Download SVG</a><a class="download" href="diagrams/${d.id}.mmd" download>Mermaid source</a><button type="button" data-print>Print / save PDF</button><label>Zoom <input aria-label="Diagram zoom" class="zoom" type="range" min="70" max="180" value="100"></label></div><div class="canvas">${svg(d)}</div><div class="legend"><span class="entity">External entity</span><span class="process">Process</span><span class="store">Data store</span><span class="component">Architecture component</span></div></section>`).join('')}<section role="tabpanel" aria-labelledby="tab-models" id="models" hidden><h2>All 63 models</h2><p class="desc">Store groups are logical views of one MongoDB database. Index counts describe schema declarations, including inline indexes; live index presence is unverified.</p><input id="search" type="search" placeholder="Search model, group, collection or reference" aria-label="Search models"><p class="small" id="model-count">63 models</p><div class="table-scroll"><table><thead><tr><th>Model</th><th>Logical store</th><th>Collection</th><th>Fields</th><th>Indexes</th><th>Reference targets</th></tr></thead><tbody>${rows}</tbody></table></div><h2 style="margin-top:28px">Audit findings</h2><div class="finding"><strong>High — default administrator bootstrap</strong>If no administrator exists, startup has a built-in password fallback and can promote an existing matching account. See server/index.js and the audit report.</div><div class="finding"><strong>High — gateway failures can be acknowledged as success</strong>The controller catches database processing errors without rethrowing; the webhook route can then return HTTP 200.</div><div class="finding"><strong>Medium — unresolved Product reference</strong>Purchase.items.productId references Product, which is not registered by the model directory.</div><div class="finding"><strong>Test baseline: 12 failures</strong>${esc(testSummary)}. The full failing-test list is in AUDIT_FINDINGS.md.</div><p><a href="AUDIT_FINDINGS.md">Read all findings and limitations</a> · <a href="audit-inventory.json">Machine-readable inventory</a> · <a href="diagrams/model-references.mmd">Full model reference graph</a></p></section></main><footer>Offline viewer — no CDN, credentials, external requests or application server required. SVG exports preserve vector text and arrows.</footer><script>
const tabs=[...document.querySelectorAll('[data-view]')];tabs.forEach(t=>t.addEventListener('click',()=>{tabs.forEach(b=>b.setAttribute('aria-selected',String(b===t)));document.querySelectorAll('[role=tabpanel]').forEach(p=>p.hidden=p.id!==t.dataset.view)}));document.querySelectorAll('[data-print]').forEach(b=>b.addEventListener('click',()=>window.print()));document.querySelectorAll('.zoom').forEach(s=>s.addEventListener('input',()=>{const svg=s.closest('section').querySelector('svg');svg.style.width=s.value+'%';svg.style.minWidth='1000px'}));document.getElementById('search').addEventListener('input',e=>{const query=e.target.value.toLowerCase();let count=0;document.querySelectorAll('tbody tr').forEach(r=>{r.hidden=!r.textContent.toLowerCase().includes(query);if(!r.hidden)count++});document.getElementById('model-count').textContent=count+' models'});
</script></body></html>`;
fs.writeFileSync(path.join(dir,'index.html'),html);
fs.writeFileSync(path.join(dir,'model-groups.json'),JSON.stringify(groups.map(([id,name,list])=>({id,name,models:list.split(' ')})),null,2)+'\n');
console.log(`Built ${diagrams.length} SVG diagrams, ${diagrams.length+1} Mermaid sources, offline viewer and model groups.`);
