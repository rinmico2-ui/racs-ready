"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {authoritativeDeliveryQuote}=require('../utils/orderCheckoutPolicy');
const routeMap=require('../public/js/order-route-map');
const SiteSetting=require('../models/SiteSetting');
const {getOrderCheckoutSettings}=require('../utils/orderCheckoutSettings');
const origin={lat:15,lng:121},destination={lat:15.1,lng:121.2};
const geometry={type:'LineString',coordinates:[[121,15],[121.05,15.08],[121.2,15.1]]};
test('unset company coordinates use the same map default instead of routing from zero',async()=>{
  const original=SiteSetting.find;
  try {
    for(const value of [null,'',undefined]){
      SiteSetting.find=()=>({lean:async()=>[{key:'companyLocationLat',value},{key:'companyLocationLng',value}]});
      assert.deepEqual((await getOrderCheckoutSettings()).companyLocation,{lat:14.676049,lng:121.043731});
    }
  } finally {SiteSetting.find=original;}
});
function mapFixture() {
  const layers=new Set(),fits=[];
  const map={hasLayer:l=>layers.has(l),removeLayer:l=>layers.delete(l),fitBounds:(b,opts)=>fits.push({b,opts})};
  const leaflet={geoJSON:(line,opts)=>({line,opts,addTo(m){layers.add(this);return this;},getBounds(){return {extend(){return this;},isValid(){return true;}};}})};
  return {layers,fits,map,leaflet};
}

test('a routing failure still returns an explicitly estimated connection between the two locations',async()=>{
  for(const data of [null,{routes:[]},{routes:[{distance:500,duration:60,geometry:{type:'LineString',coordinates:[]}}]}]){
    const quote=await authoritativeDeliveryQuote({origin,destination,farePerKm:40,httpClient:{get:async()=>{if(data===null)throw Error('timeout');return {data};}}});
    assert.equal(quote.source,'estimated');
    assert.deepEqual(quote.geometry,{type:'LineString',coordinates:[[121,15],[121.2,15.1]]});
    assert.deepEqual(quote.origin,origin);assert.deepEqual(quote.destination,destination);
    assert.ok(quote.transportationFee>0);
  }
});

test('a road quote retains its shape and server-configured origin',async()=>{
  const quote=await authoritativeDeliveryQuote({origin,destination,farePerKm:40,httpClient:{get:async()=>({data:{code:'Ok',routes:[{distance:12500,duration:1800,geometry}]}})}});
  assert.equal(quote.source,'road');assert.deepEqual(quote.geometry,geometry);assert.equal(quote.transportationFee,500);
  assert.deepEqual(quote.origin,origin);assert.deepEqual(quote.destination,destination);
});

test('route renderer replaces the previous line, fits both pins, and marks estimates as dashed',()=>{
  const f=mapFixture();
  const road=routeMap.draw({...f,quote:{source:'road',geometry,origin,destination}});
  assert.equal(road.opts.style.dashArray,null);assert.equal(f.layers.size,1);
  const estimated=routeMap.draw({...f,previousLayer:road,quote:{source:'estimated',origin,destination}});
  assert.equal(f.layers.has(road),false);assert.equal(f.layers.has(estimated),true);
  assert.equal(estimated.opts.style.dashArray,'8 8');assert.equal(f.fits.length,2);
  assert.equal(f.fits[1].opts.maxZoom,16);
  routeMap.clear(f.map,estimated);assert.equal(f.layers.size,0);
});

for(const file of ['cart-wizard.ejs','aircons.ejs']){
  function fixture(){
    const source=fs.readFileSync(path.join(__dirname,'../views/partials',file),'utf8');
    const fn=source.match(/^( +)function calcTransportFare\(custLat, custLng\) \{[\s\S]*?^\1\}/m)[0];
    const f=mapFixture(),calls=[],panels=[];
    const elements=new Map();
    const document={getElementById(id){if(!elements.has(id))elements.set(id,{textContent:'',classList:{add(){},remove(){}}});return elements.get(id);}};
    const window={OrderRouteMap:routeMap,_companyBaseLocation:origin,_farePerKm:40};
    const c=vm.createContext({document,window,L:f.leaflet,leafletMap:f.map,checkoutCalendar:null,updateRoutePanel:(...args)=>panels.push(args),fetch:()=>new Promise(resolve=>calls.push(resolve))});
    vm.runInContext('let _routeRequestId=0,_routeQuotePending=null,_routeQuoteError=null,_routeDistanceKm=0,_routeDurationMin=0,_transportFee=0;'+fn,c);
    return {...f,c,calls,elements,window,panels};
  }
  function reply(quote){return {ok:true,json:async()=>({quote})};}
  const quote={source:'road',origin,destination,geometry,distanceKm:12.5,durationMin:30,transportationFee:500,farePerKm:40};
  test(file+': a newer pin wins over an older routing response',async()=>{
    const f=fixture();
    const older=vm.runInContext('calcTransportFare(15.1,121.2)',f.c),latest=vm.runInContext('calcTransportFare(15.2,121.3)',f.c);
    f.calls[1](reply({...quote,transportationFee:600}));await latest;
    const current=f.window._routeLayer;
    f.calls[0](reply(quote));await older;
    assert.equal(f.window._routeLayer,current);assert.equal(f.layers.size,1);assert.equal(f.panels.length,1);assert.equal(f.panels[0][3],600);
  });
  test(file+': editing an address invalidates a pending route',async()=>{
    const f=fixture(),pending=vm.runInContext('calcTransportFare(15.1,121.2)',f.c);
    vm.runInContext('++_routeRequestId',f.c);
    f.calls[0](reply(quote));await pending;
    assert.equal(f.layers.size,0);assert.equal(f.panels.length,0);
  });
  test(file+': a failed quote clears the previous route and shows recovery guidance',async()=>{
    const f=fixture(),first=vm.runInContext('calcTransportFare(15.1,121.2)',f.c);
    f.calls[0](reply(quote));await first;assert.equal(f.layers.size,1);
    const failed=vm.runInContext('calcTransportFare(15.2,121.3)',f.c);
    assert.equal(f.layers.size,0);
    f.calls[1]({ok:false,json:async()=>({error:'Temporarily unavailable'})});await failed;
    assert.match(f.elements.get('orderRouteStatus').textContent,/retry/);
    assert.equal(vm.runInContext('_transportFee',f.c),0);
  });
}
