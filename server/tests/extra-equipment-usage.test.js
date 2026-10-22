'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), mongoose = require('mongoose');
const { createService, normalize } = require('../utils/extraEquipmentUsage');
const T='507f1f77bcf86cd799439011', U='507f1f77bcf86cd799439012', A='507f1f77bcf86cd799439013', B='507f1f77bcf86cd799439014', O='507f1f77bcf86cd799439015', E='507f1f77bcf86cd799439016', C='507f1f77bcf86cd799439017';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
const workDate = new Date(today+'T00:00:00+08:00');
const clone = value => structuredClone(value);
function values(row, key) {
  let rows=[row]; for(const part of key.split('.')) rows=rows.flatMap(value=>Array.isArray(value)?value.map(item=>item?.[part]):[value?.[part]]);
  return rows.flat();
}
function matches(row, query) {
  return Object.entries(query).every(([key, expected])=>{
    if(key==='$or') return expected.some(q=>matches(row,q));
    if(key==='$and') return expected.every(q=>matches(row,q));
    if(key==='$expr') {
      const expression=value=>{
        if(typeof value==='string'&&value.startsWith('$'))return values(row,value.slice(1))[0];
        if(!value||typeof value!=='object')return value;
        const [op,args]=Object.entries(value)[0],input=args.map(expression);
        if(op==='$ifNull')return input[0]??input[1];
        if(op==='$subtract')return input[0]-input[1];
        if(op==='$gte')return input[0]>=input[1];
        throw Error('Unknown expression '+op);
      };return expression(expected);
    }
    const actual=values(row,key);
    if(expected && typeof expected==='object' && !(expected instanceof Date)) return Object.entries(expected).every(([op,target])=>{
      if(op==='$in')return actual.some(v=>target.map(String).includes(String(v)));
      if(op==='$nin')return actual.every(v=>!target.map(String).includes(String(v)));
      if(op==='$ne')return actual.every(v=>String(v)!==String(target));
      if(op==='$gte')return actual.some(v=>v!=null&&new Date(v)>=new Date(target));
      if(op==='$lt')return actual.some(v=>v!=null&&new Date(v)<new Date(target));
      if(op==='$elemMatch')return actual.some(v=>matches(v,target));
      throw Error('Unknown filter '+op);
    });
    return actual.some(v=>expected==null?v==null:String(v)===String(expected));
  });
}
function fixture() {
  let data={
    Assignment:[{_id:A,bookingId:B,technicianId:T,status:'in_progress',bookingDate:workDate,startTime:'09:00',serviceName:'Cleaning'}],
    BookingService:[{_id:B,technicianId:T,assignmentId:A,status:'in-progress',bookingDate:workDate,startTime:'09:00',bookingReference:'RACS-TEST'}],
    Order:[{_id:O,technicianId:T,status:'installing',fulfillmentType:'delivery_installation',delivery:{preferredDate:workDate},orderReference:'ORD-TEST'}],
    EquipmentAssignment:[{_id:C,technicianId:T,equipmentId:E,equipmentName:'Vacuum pump',equipmentCode:'PUMP-001',quantity:2,status:'checked_out',workDate,checkedOutAt:workDate}],
    Tool:[{_id:E,itemName:'Vacuum pump',type:'equipment',inventoryClass:'operational_asset',quantity:5,checkedOutQuantity:2}], EquipmentUsageLog:[],
  };
  const writes=[],audits=[],locks=new Map();let failCreate=false, ended=0;
  const query=run=>({select(){return this;},sort(){return this;},limit(){return this;},session(){return this;},lean:async()=>clone(run())});
  function update(row,change){
    for(const [key,value]of Object.entries(change.$addToSet||{})){row[key]||=[];if(!row[key].includes(value))row[key].push(value);}
    for(const [key,value]of Object.entries(change.$inc||{}))row[key]=Number(row[key]||0)+value;
    Object.assign(row,change.$set||{});
  }
  const models=Object.fromEntries(Object.keys(data).map(name=>[name,{
    find:filter=>query(()=>data[name].filter(row=>matches(row,filter))),
    findOne:filter=>query(()=>data[name].find(row=>matches(row,filter))||null),
    findById:id=>query(()=>data[name].find(row=>String(row._id)===String(id))||null),
    async updateOne(filter, update, options){
      assert.equal(options.session,session);const row=data[name].find(row=>matches(row,filter));if(!row)return {matchedCount:0};
      writes.push(name);for(const [key,value]of Object.entries(update.$addToSet||{})){row[key]||=[];if(!row[key].includes(value))row[key].push(value);}
      for(const [key,value]of Object.entries(update.$inc||{}))row[key]=Number(row[key]||0)+value;
      Object.assign(row,update.$set||{});
      return {matchedCount:1};
    },
    async findOneAndUpdate(filter,change,options){assert.equal(options.session,session);const row=data[name].find(row=>matches(row,filter));if(!row)return null;writes.push(name);update(row,change);return clone(row);},
    async create(rows,options){assert.equal(options.session,session);if(failCreate&&name==='EquipmentUsageLog')throw Error('Write failed');writes.push(name);const saved=rows.map(row=>({_id:name==='EquipmentUsageLog'?'new-log':new mongoose.Types.ObjectId().toString(),...clone(row)}));data[name].push(...saved);return saved;},
  }]));
  models.Tool.effectiveInventoryClass=tool=>tool.inventoryClass;
  models.Tool.operationalAssetFilter=()=>({inventoryClass:'operational_asset'});
  const session={async withTransaction(fn){const before=clone(data);try{await fn();}catch(error){data=before;throw error;}},async endSession(){ended++;}};
  const service=createService({...models,mongoose:{connection:{},startSession:async()=>session},
    lock:(key,work)=>{const result=(locks.get(key)||Promise.resolve()).then(work);locks.set(key,result.catch(()=>{}));return result;},audit:async entry=>audits.push(entry)});
  const input={date:today,source:'personal',workType:'booking',workId:A,equipmentName:'Personal vacuum pump',quantity:1,notes:'Used my own pump for this job.',clientSubmissionId:'fixture-extra-record-0001'};
  return {service,input,get data(){return data;},writes,audits,get ended(){return ended;},set failCreate(value){failCreate=value;},
    record(values={}){return service.record({technicianId:T,technicianIds:[T,U],userId:U,input:{...input,...values}});}};
}
test('personal and borrowed equipment are linked to work without stock or custody writes',async()=>{
  for(const source of ['personal','borrowed']){
    const f=fixture(),before=clone(f.data.Tool);const result=await f.record({source,owner:'Borrowed from Sam'});
    assert.equal(result.item.source,source);assert.equal(result.item.bookingId,B);assert.equal(result.item.workReference,'RACS-TEST');
    assert.equal(result.item.owner,source==='personal'?'Technician personal equipment':'Borrowed from Sam');
    assert.deepEqual(f.writes,['EquipmentUsageLog']);assert.deepEqual(f.data.Tool,before);assert.equal(f.audits.length,1);
    assert.equal(f.data.EquipmentUsageLog[0].createdBy,U);assert.equal(result.item.submissionDigest,undefined);
  }
});
test('company equipment uses a verified custody snapshot and links each additional booking/order without deducting stock',async()=>{
  for(const workType of ['booking','order']){
    const f=fixture(),before=clone(f.data.Tool);
    const result=await f.record({source:'company',equipmentAssignmentId:C,workType,workId:workType==='booking'?A:O,equipmentName:'Forged name',quantity:2});
    assert.equal(result.item.equipmentName,'Vacuum pump');assert.equal(result.item.owner,'Company equipment');
    assert.deepEqual(f.data.EquipmentAssignment[0][workType==='booking'?'bookingIds':'orderIds'],[workType==='booking'?B:O]);
    assert.deepEqual(f.data.Tool,before);assert.deepEqual(f.writes,['EquipmentAssignment','EquipmentUsageLog']);
  }
});
test('company choices include held equipment and available stock, excluding reserved, damaged and non-equipment items',async()=>{
  const f=fixture();f.data.Tool.push({_id:U,type:'consumable',inventoryClass:'merchandise',quantity:100},
    {_id:A,type:'equipment',inventoryClass:'operational_asset',quantity:3,reservedQuantity:3},
    {_id:B,type:'equipment',inventoryClass:'operational_asset',quantity:3,assetStatus:'damaged'});
  f.data.Tool[0].reservedQuantity=2;
  const choices=await f.service.options({technicianIds:[T,U],date:today});
  assert.equal(choices.equipment.length,1);assert.equal(choices.stockEquipment.length,1);assert.equal(choices.stockEquipment[0].quantity,3);
  assert.equal(choices.stockCheckout.allowedDate,true);assert.equal(choices.jobs.every(job=>job.canCheckout),true);
});
test('a stock checkout atomically moves free equipment into custody and records its use once',async()=>{
  for(const workType of ['booking','order']){
    const f=fixture();f.data.Tool[0].reservedQuantity=2;
    const input={source:'company',companyMode:'stock',inventoryItemId:E,receiptConfirmed:true,quantity:2,workType,workId:workType==='booking'?A:O};
    const result=await f.record(input);
    assert.equal(f.data.Tool[0].quantity,3);assert.equal(f.data.Tool[0].checkedOutQuantity,4);assert.equal(f.data.Tool[0].reservedQuantity,2);
    assert.equal(f.data.EquipmentAssignment.length,2);assert.equal(f.data.EquipmentAssignment[1].quantity,2);
    assert.equal(f.data.EquipmentAssignment[1].status,'checked_out');assert.equal(result.item.companyMode,'stock');
    assert.equal(result.item.equipmentName,'Vacuum pump');assert.equal(f.data.EquipmentUsageLog.length,1);
    assert.equal((await f.record(input)).duplicate,true);assert.equal(f.data.Tool[0].quantity,3);assert.equal(f.data.EquipmentAssignment.length,2);
  }
});
test('stock cannot be taken without physical receipt confirmation, for completed work, or in excess of free quantity',async()=>{
  const input={source:'company',companyMode:'stock',inventoryItemId:E,receiptConfirmed:true,quantity:2};
  const unconfirmed=fixture();await assert.rejects(unconfirmed.record({...input,receiptConfirmed:false}),e=>e.status===400);assert.equal(unconfirmed.writes.length,0);
  const finished=fixture();finished.data.Assignment[0].status='completed';await assert.rejects(finished.record(input),e=>e.status===409);assert.equal(finished.data.EquipmentUsageLog.length,0);
  const reserved=fixture();reserved.data.Tool[0].reservedQuantity=4;await assert.rejects(reserved.record(input),e=>e.status===409);
  assert.equal(reserved.data.Tool[0].quantity,5);assert.equal(reserved.data.Tool[0].checkedOutQuantity,2);assert.equal(reserved.data.EquipmentAssignment.length,1);
  const paused=fixture();paused.data.BookingService[0].continuation={status:'pending'};await assert.rejects(paused.record(input),e=>e.status===409);
});
test('past work keeps existing issuance available but cannot create a backdated stock checkout',async()=>{
  const f=fixture();const date=new Date(workDate.getTime()-86400000),key=require('../utils/bookingDateTime').manilaDateKey(date);
  f.data.Assignment[0].bookingDate=date;f.data.BookingService[0].bookingDate=date;f.data.EquipmentAssignment[0].workDate=date;f.data.EquipmentAssignment[0].checkedOutAt=date;
  const choices=await f.service.options({technicianIds:[T,U],date:key});assert.equal(choices.stockCheckout.allowedDate,false);assert.equal(choices.equipment.length,1);assert.ok(choices.stockEquipment.length);
  await assert.rejects(f.record({date:key,source:'company',companyMode:'stock',inventoryItemId:E,receiptConfirmed:true}),e=>e.status===409);
  assert.equal(f.data.Tool[0].quantity,5);
});
test('a failed stock usage save rolls back inventory, the new custody record, and the job touch',async()=>{
  const f=fixture(),before=clone(f.data);f.failCreate=true;
  await assert.rejects(f.record({source:'company',companyMode:'stock',inventoryItemId:E,receiptConfirmed:true}),/Write failed/);
  assert.deepEqual(f.data,before);assert.equal(f.audits.length,0);
});
test('separate stock requests cannot take units already checked out or reserved',async()=>{
  const f=fixture();f.data.Tool[0].reservedQuantity=2;
  const input={source:'company',companyMode:'stock',inventoryItemId:E,receiptConfirmed:true,quantity:2};
  await f.record(input);
  await assert.rejects(f.record({...input,clientSubmissionId:'second-extra-record-0002'}),error=>error.status===409);
  assert.equal(f.data.Tool[0].quantity,3);assert.equal(f.data.Tool[0].reservedQuantity,2);assert.equal(f.data.EquipmentUsageLog.length,1);
  await f.record({...input,quantity:1,clientSubmissionId:'third-extra-record-0003'});
  assert.equal(f.data.Tool[0].quantity,2);assert.equal(f.data.Tool[0].reservedQuantity,2);assert.equal(f.data.EquipmentUsageLog.length,2);
  const choices=await f.service.options({technicianIds:[T,U],date:today});assert.equal(choices.stockEquipment.length,0);
});
test('foreign, not-started, cancelled-before-arrival and reassigned work cannot receive an extra equipment record',async()=>{
  for(const change of [f=>{f.data.Assignment[0].technicianId=E;},f=>{f.data.Assignment[0].status='accepted';},
    f=>{f.data.Assignment[0].status='cancelled';},f=>{f.data.BookingService[0].technicianId=E;}]){
    const f=fixture();change(f);await assert.rejects(f.record(),e=>e.status===403);assert.equal(f.writes.length,0);
  }
});
test('company stock cannot be claimed from another technician, a reservation, or consumable catalog items',async()=>{
  for(const change of [f=>{f.data.EquipmentAssignment[0].technicianId=U+'0';},f=>{f.data.EquipmentAssignment[0].status='reserved';},
    f=>{f.data.Tool[0].type='consumable';},f=>{f.data.EquipmentAssignment[0].returnPending=true;}]){
    const f=fixture();change(f);await assert.rejects(f.record({source:'company',equipmentAssignmentId:C}),e=>[400,403,409].includes(e.status));
    assert.equal(f.data.EquipmentUsageLog.length,0);assert.equal(f.data.Tool[0].quantity,5);
  }
  const f=fixture();await assert.rejects(f.record({source:'company',equipmentAssignmentId:C,quantity:3}),e=>e.status===400);
});
test('duplicate submissions return the saved record once, while changed payloads require a new submission',async()=>{
  const f=fixture();const [a,b]=await Promise.all([f.record(),f.record()]);
  assert.equal(a.duplicate,false);assert.equal(b.duplicate,true);assert.equal(f.data.EquipmentUsageLog.length,1);assert.equal(f.audits.length,1);
  await assert.rejects(f.record({notes:'Changed reason after a saved request.'}),e=>e.status===409);
});
test('a failed log write rolls back a company equipment job link and emits no successful audit',async()=>{
  const f=fixture();f.failCreate=true;await assert.rejects(f.record({source:'company',equipmentAssignmentId:C}),/Write failed/);
  assert.equal(f.data.EquipmentAssignment[0].bookingIds,undefined);assert.equal(f.data.EquipmentUsageLog.length,0);assert.equal(f.audits.length,0);assert.equal(f.ended,1);
});
test('invalid quantities, unknown sources, empty reasons and missing borrowed owners fail before saving',()=>{
  const f=fixture();for(const changes of [{quantity:0},{quantity:1.5},{quantity:10001},{source:'consumable'},
    {notes:' '},{source:'borrowed',owner:''},{workId:'wrong'},{clientSubmissionId:'bad!'}])assert.throws(()=>normalize({...f.input,...changes}),e=>e.status===400);
});
test('the equipment-log schema supports personal equipment while retaining company asset validation',async()=>{
  const Model=require('../models/EquipmentUsageLog');
  const base={technicianId:T,equipmentName:'Personal pump',date:workDate,source:'personal',recordKind:'extra'};
  await new Model(base).validate();
  await assert.rejects(new Model({...base,source:'company'}).validate(),error=>Boolean(error.errors.equipmentId));
});
test('the actual extra-equipment route derives ownership from the session instead of the submitted form',async()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const source=fs.readFileSync(require.resolve('../routes/technicianApi'),'utf8');
  const start=source.indexOf("router.post('/equipment-usage/extra',"),end=source.indexOf('\nrouter.',start+5);
  let handler,captured;
  vm.runInNewContext(source.slice(start,end),{
    router:{post(path,fn){handler=fn;}},
    loadTechnicianContext:async user=>{assert.equal(user,U);return{tech:{_id:T},technicianIds:[T,U]};},
    require:()=>({createService:()=>({record:async args=>{captured=args;return{item:{equipmentName:'Personal pump'},duplicate:false};}})}),
  });
  const response={status(code){this.code=code;return this;},json(value){this.body=value;}};
  await handler({user:{_id:U},body:{technicianId:E,userId:E,technicianIds:[E],source:'personal'}},response,error=>{throw error;});
  assert.equal(captured.technicianId,T);assert.equal(captured.userId,U);assert.deepEqual(Array.from(captured.technicianIds),[T,U]);
  assert.equal(response.code,201);assert.equal(response.body.success,true);
});
