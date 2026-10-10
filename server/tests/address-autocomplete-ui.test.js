'use strict';
const assert = require('node:assert/strict'), test = require('node:test');
const { create } = require('../public/js/address-autocomplete');
const tick = () => new Promise(setImmediate);
function fixture() {
  let doc; const nodes = [];
  function element(tag = 'div') {
    const events = {}, attrs = {}, classes = new Set();
    const node = { tag,ownerDocument:null,children:[],value:'',id:'',textContent:'',style:{},innerHTML:'Search',disabled:false,
      classList:{ add:className => classes.add(className),remove:className => classes.delete(className),contains:className => classes.has(className) },
      setAttribute(key,value) { attrs[key] = value; },getAttribute:key => attrs[key],
      append(...children) { this.children.push(...children); },replaceChildren(...children) { this.children = children; },
      contains(target) { return this === target || this.children.some(child => child.contains?.(target)); },
      focus() { this.focused = true; },
      addEventListener(type,fn) { (events[type] ||= []).push(fn); },
      emit(type,event = {}) { return Promise.all((events[type] || []).map(fn => fn({ target:node,preventDefault() {},...event }))); },
    }; node.ownerDocument = doc; nodes.push(node); return node;
  }
  doc = element(); doc.createElement = element; doc.createTextNode = text => ({ textContent:text });
  const input = element('input'), list = element(); list.id = 'suggestions'; const search = element('button');
  const tasks = new Map(), calls = [], selections = [], edits = []; let timerId = 0;
  const win = { document:doc,AbortController,clearTimeout:id => tasks.delete(id),setTimeout:fn => { tasks.set(++timerId,fn); return timerId; },
    fetch:(url,options) => new Promise(resolve => calls.push({ url,options,resolve })) };
  const api = create({ input,list,searchButton:search,onSelect:result => selections.push(result),onInput:query => edits.push(query) },win);
  async function type(value) { input.value = value; await input.emit('input'); }
  function flush() { for (const [id,fn] of tasks) { tasks.delete(id); fn(); } }
  function respond(index,data,ok = true) { calls[index].resolve({ ok,status:ok ? 200 : 503,json:async () => data }); }
  return { input,list,search,calls,selections,edits,type,flush,respond,api,doc,win };
}
const address = { display_name:'Cabanatuan, Nueva Ecija, Philippines',lat:15.49,lon:120.96,source:'photon' };
test('typing debounces the latest address and selects its full label and coordinates', async () => {
  const f = fixture(); await f.type('Ca'); f.flush(); assert.equal(f.calls.length,0);
  await f.type('Cab'); await f.type('Cabanatuan'); f.flush(); assert.equal(f.calls.length,1);
  assert.match(f.calls[0].url,/q=Cabanatuan$/);
  f.respond(0,{ suggestions:[address] }); await tick();
  assert.equal(f.list.style.display,'block'); assert.equal(f.input.getAttribute('aria-expanded'),'true');
  await f.list.children[0].emit('click'); assert.equal(f.selections.length,1); assert.equal(f.input.value,address.display_name);
  assert.equal(f.selections[0].lat,15.49); assert.equal(f.list.style.display,'none');
});
test('outdated responses cannot replace results for the latest typed address', async () => {
  const f = fixture(); await f.type('Cab'); f.flush(); await f.type('Gapan'); f.flush();
  assert.equal(f.calls[0].options.signal.aborted,true);
  f.respond(1,{ suggestions:[{...address,display_name:'Gapan, Nueva Ecija, Philippines'}] }); await tick();
  f.respond(0,{ suggestions:[address] }); await tick();
  assert.equal(f.list.children[0].textContent,'Gapan, Nueva Ecija, Philippines');
});
test('clearing, Escape, and outside clicks keep a delayed response from reopening the dropdown', async () => {
  for (const dismiss of ['clear','escape','outside']) {
    const f = fixture(); await f.type('Cabanatuan'); f.flush();
    if (dismiss === 'clear') await f.type('');
    else if (dismiss === 'escape') await f.input.emit('keydown',{key:'Escape'});
    else await f.doc.emit('click',{target:{}});
    f.respond(0,{suggestions:[address]}); await tick();
    assert.equal(f.input.getAttribute('aria-expanded'),'false'); assert.equal(f.list.style.display,'none'); assert.equal(f.search.disabled,false);
  }
});
test('Search remains available after errors and ArrowDown focuses a suggestion', async () => {
  const f = fixture(); await f.type('Cabanatuan'); f.flush(); f.respond(0,{ error:'Try again.' },false); await tick();
  assert.equal(f.search.disabled,false); assert.equal(f.list.children[0].textContent,'Try again.');
  const retry = f.search.emit('click'); f.respond(1,{ suggestions:[address] }); await retry; await tick();
  assert.match(f.calls[1].url,/\/api\/geocoding\/search\?/);
  await f.input.emit('keydown',{ key:'ArrowDown' }); assert.equal(f.list.children[0].focused,true);
});
test('empty results and foreign coordinates never select a location', async () => {
  const f = fixture(); await f.type('Unknown place'); f.flush();
  f.respond(0,{ suggestions:[{...address,lat:40,lon:-74}] }); await tick();
  assert.match(f.list.children[0].textContent,/No matches/); assert.equal(f.selections.length,0);
});
