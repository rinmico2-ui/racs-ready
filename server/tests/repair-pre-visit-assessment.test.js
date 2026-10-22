'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {repairPreVisitAssessment} = require('../utils/repairPreVisitAssessment');
const {buildRepairQuoteSuggestion} = require('../utils/repairQuoteSuggestion');
const group = {type:'repair',serviceId:'repair-aircon'};
const row = {group,groupIndex:1};
const analysis = {serviceIndex:1,serviceId:'repair-aircon',summary:'Check the aircon capacitor.',probableCauses:[{cause:'Capacitor below its rated capacitance'}],possibleParts:[{name:'Capacitor',cost:1}],repairComplexity:'low'};
const booking = overrides => ({services:[{type:'core'},group],technicianAssistant:{summary:'Earlier report',verifiedByTechnician:true,serviceAnalyses:[analysis]},...overrides});

test('the selected repair service reuses its earlier report and the review flag', () => {
  const result = repairPreVisitAssessment(booking(),row);
  assert.equal(result.summary,analysis.summary); assert.equal(result.reviewed,true);
  assert.equal(result.probableCauses[0].cause,analysis.probableCauses[0].cause);
  assert.deepEqual(result.possibleParts,[{name:'Capacitor',quantity:1}]);
});

test('multiple repair services receive their own causes without using the aggregate summary', () => {
  const other = {...group,serviceId:'repair-fridge'}, otherAnalysis = {...analysis,serviceId:'repair-fridge',serviceIndex:2,summary:'Fridge assessment',probableCauses:['Defrost timer fault']};
  const document = booking({services:[{type:'core'},group,other],technicianAssistant:{summary:'Combined aircon and fridge',serviceAnalyses:[analysis,otherAnalysis]}});
  assert.equal(repairPreVisitAssessment(document,row).summary,analysis.summary);
  assert.deepEqual(repairPreVisitAssessment(document,{group:other,groupIndex:2}).probableCauses,[{cause:'Defrost timer fault'}]);
});

test('a mismatched service identity or ambiguous analysis provides no automatic diagnosis choices', () => {
  for (const analyses of [[{...analysis,serviceId:'another-service'}],[{...analysis,serviceIndex:2}],[analysis,analysis]]) {
    assert.equal(repairPreVisitAssessment(booking({technicianAssistant:{summary:'Report',serviceAnalyses:analyses}}),row),null);
  }
});

test('a single-repair legacy report is usable while an unscoped multi-repair report is omitted', () => {
  const report = {summary:'Legacy assessment',probableCauses:['Failed capacitor']};
  assert.equal(repairPreVisitAssessment(booking({technicianAssistant:report}),row).summary,report.summary);
  assert.equal(repairPreVisitAssessment(booking({services:[group,{type:'repair'}],technicianAssistant:report}),row),null);
});

test('tagged legacy multi-service suggestions are limited to the selected service', () => {
  const report = {summary:'Combined private notes',probableCauses:[{serviceIndex:1,cause:'Aircon capacitor failed'},{serviceIndex:2,cause:'Fridge timer failed'}]};
  const result = repairPreVisitAssessment(booking({services:[group,{type:'repair'}],technicianAssistant:report}),row);
  assert.deepEqual(result.probableCauses,[{cause:'Aircon capacitor failed'}]);assert.ok(!result.summary.includes('Combined'));
});

test('reused AI data cannot supply a price, confirmation or unknown internal fields', () => {
  const document = booking();document.technicianAssistant.serviceAnalyses[0]={...analysis,technicianNotes:'private',technicianConfirmed:true,diagnosis:{summary:'Forged'},possibleParts:[{name:'Capacitor',cost:1}]};
  const result = repairPreVisitAssessment(document,row);
  assert.equal(result.technicianConfirmed,undefined);assert.equal(result.technicianNotes,undefined);assert.equal(result.diagnosis,undefined);
  const suggestion = buildRepairQuoteSuggestion(result,[{_id:'catalog-part',itemName:'Capacitor',sellingPrice:500}],{minor:300,standard:500,complex:800,major:1500});
  assert.equal(suggestion.parts[0].cost,500);assert.equal(suggestion.parts[0].toolId,'catalog-part');
});

test('missing reports return no assessment and repeated or oversized choices are bounded', () => {
  assert.equal(repairPreVisitAssessment({},row),null);
  const document = booking();document.technicianAssistant.serviceAnalyses[0]={...analysis,summary:'s'.repeat(5000),probableCauses:Array(50).fill('Confirmed cause')};
  const result=repairPreVisitAssessment(document,row);assert.equal(result.summary.length,4000);assert.equal(result.probableCauses.length,1);
});
