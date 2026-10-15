'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/js/services-multi.js'),'utf8');
const start=source.indexOf('async function selectServiceAddressSuggestion('),end=source.indexOf('\nfunction displaySuggestions(',start);
const locality=require('../utils/nuevaEcijaAddresses').suggestions('Puncan')[0];
const point={...locality,lat:15.906146,lon:120.9918457,match_level:'area'};
function fixture(){
  const nodes={locationInput:{value:'Puncan'},serviceAddressSearchBtn:{disabled:false},locationStatus:{hidden:false}},calls=[],applied=[],recovery=[];let guided=0;
  const context=vm.createContext({addressAutocompleteDebounceTimer:null,addressSuggestionRequestToken:0,addressSuggestionAbortController:null,AbortController,setTimeout,clearTimeout,
    document:{getElementById:id=>nodes[id]},closeAddressSuggestions(){},resetServiceLocationForTypedAddress(){},
    applyAddressSearchResult:result=>{applied.push(result);nodes.locationInput.value=result.display_name;return true;},guideToSelectedAddressMap(){guided++;},
    guideToManualAddressPin(){},showServiceAddressRecovery:message=>recovery.push(message),
    window:{AddressAutocomplete:{resolveSelection:(_result,options)=>new Promise((resolve,reject)=>calls.push({resolve,reject,...options}))}}});
  vm.runInContext(source.slice(start,end),context);
  return{context,nodes,calls,applied,recovery,guided:()=>guided,select:()=>context.selectServiceAddressSuggestion(locality)};
}
test('a services locality selection fetches coordinates then moves and focuses the map pin',async()=>{
  const f=fixture(),pending=f.select();assert.equal(f.calls.length,1);assert.equal(f.nodes.serviceAddressSearchBtn.disabled,true);assert.equal(f.applied.length,0);
  f.calls[0].resolve(point);await pending;
  assert.equal(f.applied[0],point);assert.equal(f.guided(),1);assert.equal(f.nodes.serviceAddressSearchBtn.disabled,false);
});
test('a services lookup cannot overwrite newer typed text or a newly chosen map pin',async()=>{
  const f=fixture(),pending=f.select();f.context.addressSuggestionRequestToken++;f.nodes.locationInput.value='New customer address';
  f.calls[0].resolve(point);await pending;assert.equal(f.applied.length,0);assert.equal(f.recovery.length,0);assert.equal(f.nodes.locationInput.value,'New customer address');
});
test('an unavailable services lookup preserves the label and offers inline map recovery',async()=>{
  for(const fail of [false,true]){const f=fixture(),pending=f.select();if(fail)f.calls[0].reject(SyntaxError('Bad Gateway'));else f.calls[0].resolve(null);await pending;
    assert.equal(f.applied.length,0);assert.equal(f.nodes.locationInput.value,locality.display_name);assert.equal(f.nodes.serviceAddressSearchBtn.disabled,false);
    assert.match(f.recovery[0],/Try Search again.*pin/);assert.doesNotMatch(f.recovery[0],/Bad Gateway/);}
});
