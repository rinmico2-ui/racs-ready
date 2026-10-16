'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../public/js/book-history.js'),'utf8');
function fixture(overrides={}){
  const fields=new Map(),messages=[],requests=[];let shown=0,hidden=0,refreshed=0;
  const node=id=>{if(!fields.has(id))fields.set(id,{value:'',checked:false,disabled:false,textContent:'',classList:{add(){},remove(){}}});return fields.get(id);};
  const coverage=node('bhClaimCoverage');Object.defineProperty(coverage,'innerHTML',{set(value){this.markup=value;this.value=value.match(/value="([^"]+)"/)?.[1]||'';},get(){return this.markup;}});
  const modal={dataset:{},querySelector:selector=>node(selector.slice(1))};
  const eligibility={eligible:true,coverages:[{coverageId:'coverage-1',serviceName:'Aircon cleaning',endDate:'2026-10-16T18:00:00Z',itemKey:'unit-1',allowedClaimTypes:['installation_workmanship']}],items:[{itemKey:'unit-1',name:'Bedroom aircon'}],activeClaims:[],...overrides};
  class Clock extends Date{constructor(...args){super(...(args.length?args:['2026-10-16T18:00:00Z']));}}
  const context={window:{},document:{getElementById:id=>id==='bhWarrantyClaimModal'?modal:null},Date:Clock,Intl,
    alert:message=>messages.push(message),confirm:()=>false,fetchBookings:()=>{refreshed++;},FormData:class extends Map{constructor(){super([['description','The appliance is no longer cooling.'],['coverageId','coverage-1'],['itemKey','unit-1']]);}},
    fetch:async(url,options)=>{requests.push({url,options});return{ok:true,json:async()=>options?.method==='POST'?{claim:{claimReference:'WC-TEST'}}:eligibility};},
    bootstrap:{Modal:{getOrCreateInstance:()=>({show(){shown++;}}),getInstance:()=>({hide(){hidden++;}})}}};
  const helperStart=source.indexOf('  function fmtLongDate('),helperEnd=source.indexOf('  function formatDateTime(',helperStart);
  assert.ok(helperStart>0&&helperStart<source.indexOf('  function showDetailModal('),'The date helper must be available to both detail and warranty handlers');
  const escapeStart=source.indexOf('  function escapeHtml('),escapeEnd=source.indexOf('  async function downloadBookingPdf(',escapeStart);
  const handlerStart=source.indexOf('  window.bhWarrantyClaim ='),handlerEnd=source.lastIndexOf('})();');
  vm.runInNewContext(source.slice(helperStart,helperEnd)+source.slice(escapeStart,escapeEnd)+source.slice(handlerStart,handlerEnd),context);
  return{context,node,modal,messages,requests,get shown(){return shown;},get hidden(){return hidden;},get refreshed(){return refreshed;},open:()=>context.window.bhWarrantyClaim('booking-1')};
}
test('reporting a warranty issue opens coverage and affected-unit choices without a formatter ReferenceError',async()=>{
  const f=fixture();await f.open();assert.deepEqual(f.messages,[]);assert.equal(f.shown,1);
  assert.match(f.node('bhClaimCoverage').innerHTML,/October 17, 2026/);assert.match(f.node('bhClaimItem').innerHTML,/Bedroom aircon/);
  assert.equal(f.node('bhClaimDiscovered').value,'2026-10-17');assert.equal(f.modal.dataset.bookingId,'booking-1');
});
test('warranty submission preserves the selected booking, coverage and unit and closes only after a successful response',async()=>{
  const f=fixture();await f.open();await f.node('bhWarrantyClaimForm').onsubmit({preventDefault(){}});
  const sent=f.requests.find(request=>request.options?.method==='POST');assert.equal(sent.url,'/api/warranty-claims');
  assert.equal(sent.options.body.get('sourceType'),'booking');assert.equal(sent.options.body.get('sourceId'),'booking-1');
  assert.equal(sent.options.body.get('coverageId'),'coverage-1');assert.equal(sent.options.body.get('itemKey'),'unit-1');
  assert.equal(f.hidden,1);assert.equal(f.refreshed,1);assert.equal(f.node('bhClaimSubmit').disabled,false);
});
test('coverage dates use Manila time and malformed or absent dates have a readable placeholder',()=>{
  const f=fixture();assert.match(f.context.fmtLongDate('2026-10-16T18:00:00Z'),/October 17, 2026/);
  for(const value of [null,undefined,'','invalid-date'])assert.equal(f.context.fmtLongDate(value),'—');
});
test('coverage names remain escaped and missing end dates do not prevent opening a claim',async()=>{
  const f=fixture({coverages:[{coverageId:'c1',serviceName:'<img onerror=alert(1)>',endDate:null,allowedClaimTypes:[]}]});
  await f.open();assert.equal(f.shown,1);assert.deepEqual(f.messages,[]);assert.match(f.node('bhClaimCoverage').innerHTML,/&lt;img/);
  assert.doesNotMatch(f.node('bhClaimCoverage').innerHTML,/<img/);assert.match(f.node('bhClaimCoverage').innerHTML,/until —/);
});
test('expired coverage and existing active claims still prevent another claim form',async()=>{
  const unavailable=fixture({eligible:false});await unavailable.open();assert.equal(unavailable.shown,0);assert.match(unavailable.messages[0],/No active warranty/);
  const active=fixture({activeClaims:[{claimReference:'WC-EXISTING',status:'submitted'}]});await active.open();assert.equal(active.shown,0);assert.match(active.messages[0],/already active/);
});
