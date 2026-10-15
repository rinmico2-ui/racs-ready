'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const core = fs.readFileSync(path.join(__dirname,'../public/js/core-appliance-booking.js'),'utf8');
const chat = fs.readFileSync(path.join(__dirname,'../views/partials/chatbot.ejs'),'utf8');
function fn(source, name, end) { const start=source.indexOf('  function '+name+'('); assert.ok(start>=0); return source.slice(start,source.indexOf(end,start)); }

test('staff identification never submits stale hidden brand, model, type or HP as confirmed details',()=>{
  const fields={kind:{value:'aircon'},quantity:{value:'2'},brand:{value:'Old brand'},model:{value:'OLD-MODEL'},hp:{value:'3'},airconType:{value:'split'}};
  const context=vm.createContext({detailsUnknown:true,field:name=>fields[name],Number});
  vm.runInContext(fn(core,'selection','  function draft('),context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.selection())),{applianceKind:'aircon',quantity:2,brand:"I don't know",model:'',airconType:null,hp:null});
  context.detailsUnknown=false;
  assert.equal(context.selection().model,'OLD-MODEL'); assert.equal(context.selection().hp,3);
});

test('help choices cannot skip selection; staff mode validates quantity while normal booking still requires a model',()=>{
  const fields={kind:{value:'aircon'},quantity:{value:'2',validity:{valid:true}},brand:{value:'Carrier',validity:{valid:true}},model:{value:'',validity:{valid:false}},airconType:{validity:{valid:true}},hp:{validity:{valid:true}}};
  const context=vm.createContext({detailsUnknown:false,helpOpen:true,available:()=>40,field:name=>fields[name],selection:()=>({brand:'Carrier'})});
  vm.runInContext(fn(core,'detailsValid','  function closeConfirmation('),context);
  assert.equal(context.detailsValid(),false);
  context.detailsUnknown=true; assert.equal(context.detailsValid(),true);
  fields.quantity.validity.valid=false; assert.equal(context.detailsValid(),false);
  context.detailsUnknown=false; context.helpOpen=false; fields.quantity.validity.valid=true;
  assert.equal(context.detailsValid(),false); fields.model.validity.valid=true; assert.equal(context.detailsValid(),true);
});

test('choosing staff goes to Services without sending a request and choosing AI only opens guidance',()=>{
  const steps=[],prompts=[],messages=[];
  const context=vm.createContext({detailsUnknown:false,helpOpen:false,closeConfirmation(){},refreshServices(){},changed(){},updateTotal(){},setStep:value=>steps.push(value),
    hooks:{},field:()=>({value:'freezer',focus(){}}),window:{RACSChat:{openUnitIdentification:input=>prompts.push(input)}},message:text=>messages.push(text)});
  vm.runInContext(fn(core,'chooseHelp','  function setStep('),context);
  context.chooseHelp('staff');assert.deepEqual(steps,[3]);assert.equal(context.detailsUnknown,true);
  context.chooseHelp('ai');assert.equal(prompts[0].applianceKind,'freezer');assert.equal(context.detailsUnknown,false);assert.equal(context.helpOpen,true);
  delete context.window.RACSChat; context.chooseHelp('ai');assert.match(messages.at(-1),/temporarily unavailable/);
  context.chooseHelp('manual');assert.equal(context.helpOpen,false);
});

test('staff request confirmation is a separate review step and can be cancelled without sending',()=>{
  const nodes=new Map();const host={querySelector(selector){if(!nodes.has(selector))nodes.set(selector,{hidden:true,focus(){},scrollIntoView(){}});return nodes.get(selector);}};
  const context=vm.createContext({host,step:3,confirmationOpen:false,A:{labels:{aircon:'Aircon'}}});
  vm.runInContext(fn(core,'closeConfirmation','  function chooseHelp('),context);
  context.showConfirmation({applianceKind:'aircon',quantity:2},{name:'Cleaning'});
  assert.equal(context.confirmationOpen,true);assert.equal(nodes.get('[data-request-confirmation]').hidden,false);
  assert.match(nodes.get('[data-confirm-summary]').textContent,/Cleaning for 2 aircon appliances/);
  context.closeConfirmation();assert.equal(context.confirmationOpen,false);assert.equal(nodes.get('[data-request-confirmation]').hidden,true);
});

function chatFixture() {
  let open=false,opens=0,changes=0;const bubbles=[],history=[],input={value:'',dispatchEvent(){changes++;},focus(){}};
  const context=vm.createContext({win:{classList:{contains:()=>open}},toggleChat(){open=true;opens++;},isStreaming:false,identificationGuides:new Set(),identificationDraft:null,input,history,
    messages:{querySelector(){return null;}},requestAnimationFrame:callback=>callback(),appendMessage:(...args)=>bubbles.push(args),saveHistory(){},scrollBottom(){},Event:class{},Date});
  vm.runInContext(fn(chat,'openUnitIdentification','  window.RACSChat ='),context);
  return {context,bubbles,history,input,opens:()=>opens,changes:()=>changes};
}
test('AI opens with label guidance and an editable question, without sending a chat or staff request',()=>{
  const f=chatFixture();f.context.openUnitIdentification({applianceKind:'aircon'});
  assert.equal(f.opens(),1);assert.equal(f.bubbles.length,1);assert.equal(f.changes(),1);
  assert.match(f.input.value,/exact text from the unit label/);assert.match(f.history[0].content,/cannot confirm missing HP/);
  f.context.openUnitIdentification({applianceKind:'aircon'});assert.equal(f.opens(),1);assert.equal(f.bubbles.length,1);
  f.context.openUnitIdentification({applianceKind:'freezer'});assert.match(f.input.value,/freezer/);assert.doesNotMatch(f.input.value,/aircon's/);
});
test('AI preserves an unsent customer question and rejects unsupported appliance context',()=>{
  const f=chatFixture();f.input.value='My existing question';
  f.context.openUnitIdentification({applianceKind:'<script>'});
  assert.equal(f.input.value,'My existing question');assert.doesNotMatch(f.history[0].content,/<script>/);
  f.context.openUnitIdentification({applianceKind:'refrigerator'});assert.match(f.history.at(-1).content,/refrigerator/);
});
test('opening identification during an AI reply does not interrupt or duplicate that reply',()=>{
  const f=chatFixture();f.context.isStreaming=true;f.context.openUnitIdentification({applianceKind:'aircon'});
  assert.equal(f.opens(),1);assert.equal(f.bubbles.length,0);assert.equal(f.input.value,'');
});

test('brand selections resolve Other to the typed brand and staff mode discards both hidden values',()=>{
  const fields={kind:{value:'aircon'},quantity:{value:'1'},brand:{value:'__other__'},brandCustom:{value:'Custom HVAC'},model:{value:'MODEL-123'},hp:{value:'1'},airconType:{value:'split'}};
  const context=vm.createContext({detailsUnknown:false,field:name=>fields[name],Number});
  vm.runInContext(fn(core,'selection','  function draft('),context);
  assert.equal(context.selection().brand,'Custom HVAC');
  fields.brand.value='Carrier';assert.equal(context.selection().brand,'Carrier');
  context.detailsUnknown=true;assert.equal(context.selection().brand,"I don't know");assert.equal(context.selection().model,'');
});

test('repair AI guidance uses the selected appliance instead of assuming it is an aircon',()=>{
  const f=chatFixture();f.context.openUnitIdentification({applianceLabel:'Washing Machine'});
  assert.match(f.input.value,/Washing Machine/);assert.doesNotMatch(f.input.value,/aircon/);
  assert.match(f.history[0].content,/Ask staff to identify my unit/);
});
