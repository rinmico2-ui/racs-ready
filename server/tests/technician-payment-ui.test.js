'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const pricing=require('../public/js/repair-visit-payment');
const source=fs.readFileSync(require.resolve('../views/pages/technician/assignments.ejs'),'utf8');
const bookingId='000000000000000000000001';
function completion(booking,ok=true){
  const calls=[];
  const context={window:{RepairVisitPayment:pricing,_detailAssignment:{_id:'assignment',bookingId}},
    fetch:async()=>({ok,json:async()=>ok?{booking}:{error:'Payment check unavailable'}}),
    Swal:{fire(...args){calls.push({type:'message',args});return Promise.resolve({isConfirmed:false});}},
    openModalAfterClose(...args){calls.push({type:'open',modal:args[0]});args[2]();},
    openMaterialsModal(id){calls.push({type:'materials',id});},collectRepairPayment(){assert.fail('Unexpected collection');}};
  const start=source.indexOf('  async function completeRepair('),end=source.indexOf('  let _workGuideBookingId',start);
  vm.runInNewContext(source.slice(start,end),context);
  return {calls,run:()=>context.completeRepair(bookingId)};
}
test('repair completion opens materials and proof without payment when the verified total is paid',async()=>{
  const f=completion({serviceType:'repair',initialCost:500,travelFare:50,totalInitialCost:550,quotation:{totalCost:900},amountPaid:1450,repairPaymentCollected:false,balanceCollected:false});
  await f.run();assert.deepEqual(f.calls,[{type:'open',modal:'materialsModal'},{type:'materials',id:bookingId}]);
});
test('a fully paid core visit still requires the later quoted repair balance',async()=>{
  const f=completion({serviceType:'mixed',totalInitialCost:1750,quotation:{totalCost:900},amountPaid:1750,balanceCollected:true});
  await f.run();assert.equal(f.calls.length,1);assert.equal(f.calls[0].type,'message');
  assert.match(f.calls[0].args[0].html,/900/);assert.doesNotMatch(f.calls[0].args[0].html,/1,750/);
});
test('a failed fresh payment check cannot open completion or a collection form',async()=>{
  const f=completion({},false);await f.run();assert.equal(f.calls.length,1);assert.equal(f.calls[0].type,'message');
});
test('the shared payment dialog skips its form for full payment and verifies the current booking first',async()=>{
  const calls=[],context={window:{RepairVisitPayment:pricing},fetch:async()=>({ok:true,json:async()=>({booking:{serviceType:'core',totalPrice:3000,amountPaid:3000,balanceCollected:false}})}),
    Swal:{fire(){assert.fail('Payment form or message is unnecessary before completion');}},
    openProofModal(...args){calls.push(args);}};
  const start=source.indexOf('    window.openCollectPaymentModal = async function'),end=source.indexOf('      // Opening a modal',start);
  vm.runInNewContext(source.slice(start,end)+"return 'collection-required';};",context);
  await context.window.openCollectPaymentModal('assignment',{bookingId,customerName:'Customer',serviceName:'Cleaning',balanceAmount:3000},true);
  assert.deepEqual(calls,[['assignment','Customer','Cleaning',3000,true]]);
  let proceeded=false;await context.window.openCollectPaymentModal('assignment',{bookingId},false,()=>{proceeded=true;});assert.equal(proceeded,true);
});

test('opening completion proof refreshes a stale unpaid snapshot and does not loop into collection',async()=>{
  const calls=[],context={window:{RepairVisitPayment:pricing},allItems:[{_id:'assignment',bookingId,balanceAmount:3000,balanceCollected:false}],
    fetch:async()=>({ok:true,json:async()=>({booking:{serviceType:'core',totalPrice:3000,amountPaid:3000,balanceAmount:3000}})}),
    showNotification(){assert.fail('A paid job should not be blocked');},openCollectPaymentModal(){assert.fail('A paid job should not reopen collection');}};
  const start=source.indexOf('    window.openProofModal = async function'),end=source.indexOf('      proofTargetId = id;',start);
  vm.runInNewContext(source.slice(start,end)+"return 'proof-ready';};",context);
  assert.equal(await context.window.openProofModal('assignment','Customer','Cleaning',3000),'proof-ready');
  context.fetch=async()=>({ok:true,json:async()=>({booking:{serviceType:'core',totalPrice:3000,amountPaid:500}})});
  context.openCollectPaymentModal=(...args)=>calls.push(args);
  await context.window.openProofModal('assignment','Customer','Cleaning',3000);
  assert.equal(calls.length,1);assert.equal(calls[0][0],'assignment');assert.equal(calls[0][2],true);
});
