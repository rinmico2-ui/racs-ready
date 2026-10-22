'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const flow = require('../utils/repairUnitWorkflow');
const source = fs.readFileSync(require.resolve('../public/js/repair-units.js'), 'utf8');

function fixture(inspection = {}) {
  const context = { window:{}, document:{}, Intl };
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'window.inspectionTest={inspectionNotes,inspectionFields,validateNotes,inspectionPayload,bindDiagnosis};})();'), context);
  const ui = context.window.inspectionTest, unit = { inspection };
  const notes = { value:ui.inspectionNotes(unit), message:'', setCustomValidity(value) { this.message = value; }, checkValidity() { return !this.message; } };
  const form = { dataset:{key:'G1-U001'}, _originalInspection:{notes:notes.value,findings:inspection.findings || '',testsPerformed:inspection.testsPerformed || ''},
    elements:{inspectionNotes:notes,diagnosis:{value:'Capacitor failed the capacitance test.'},recommendedAction:{value:'Replace the capacitor and retest cooling.'},technicianConfirmed:{checked:false}} };
  const document = { serviceType:'repair', services:[{type:'repair',quantity:1,units:flow.customerUnits({quantity:1,problemDescription:'Aircon powers on but does not cool.'})}] };
  flow.ensureUnits(document)[0].unit.inspection = structuredClone(inspection);
  return { ui, form, notes, document, payload:()=>JSON.parse(JSON.stringify(ui.inspectionPayload(form))) };
}

test('one technician-written checks and findings note can be saved, quoted and confirmed without a second copy to type', () => {
  const f = fixture(); f.notes.value = 'Checked airflow and measured the capacitor: below its rated capacitance.';
  assert.equal(f.ui.validateNotes(f.form), true);
  flow.saveInspectionDraft(f.document, 'G1-U001', f.payload(), {technicianId:'technician'});
  assert.equal(f.document.quotationReview, undefined);
  flow.inspect(f.document, 'G1-U001', {...f.payload(),parts:[],laborCategory:'standard'}, {technicianId:'technician',laborFees:{standard:500}});
  assert.throws(() => flow.submitInspection(f.document), /Confirm that you inspected/);
  f.form.elements.technicianConfirmed.checked = true;
  flow.inspect(f.document, 'G1-U001', {...f.payload(),parts:[],laborCategory:'standard'}, {technicianId:'technician',laborFees:{standard:500}});
  flow.submitInspection(f.document);
  const stored = flow.rows(f.document)[0].unit;
  assert.equal(stored.inspection.findings, f.notes.value);
  assert.equal(stored.inspection.testsPerformed, f.notes.value);
  assert.equal(stored.quotation.totalCost, 500);
  assert.equal(f.document.quotationReview.status, 'pending');
});

test('distinct older findings and readings survive editing the diagnosis and saving the combined form', () => {
  const inspection = {findings:'Earlier findings '+ 'a'.repeat(1500),testsPerformed:'Earlier readings '+ 'b'.repeat(1500),photos:['saved-evidence']};
  const f = fixture(inspection);
  assert.ok(f.notes.value.length > 2000); assert.equal(f.ui.validateNotes(f.form), true);
  flow.saveInspectionDraft(f.document, 'G1-U001', f.payload(), {technicianId:'technician'});
  const stored = flow.rows(f.document)[0].unit.inspection;
  assert.equal(stored.findings, inspection.findings);
  assert.equal(stored.testsPerformed, inspection.testsPerformed);
  assert.deepEqual(stored.photos, inspection.photos);
});

test('empty notes and edited notes above the server limit block progression without truncating historical text', () => {
  const f = fixture({findings:'Observed compressor condition.',testsPerformed:'Measured compressor winding resistance.'});
  f.notes.value = ' '; assert.equal(f.ui.validateNotes(f.form), false);
  assert.match(f.notes.message, /at least 10/);
  f.notes.value = 'x'.repeat(2001); assert.equal(f.ui.validateNotes(f.form), false);
  assert.equal(f.notes.value.length, 2001); assert.match(f.notes.message, /2,000/);
  f.notes.value = 'Checked winding resistance; the motor is open circuit.';
  assert.equal(f.ui.validateNotes(f.form), true);
  assert.equal(f.payload().testsPerformed, f.notes.value);
});

test('AI diagnosis alone never manufactures an inspection note or the technician confirmation', () => {
  const f = fixture();
  assert.equal(f.ui.validateNotes(f.form), false);
  assert.equal(f.payload().findings, ''); assert.equal(f.payload().testsPerformed, '');
  assert.equal(f.payload().technicianConfirmed, false);
  assert.throws(() => flow.saveInspectionDraft(f.document, 'G1-U001', f.payload(), {}), /Inspection findings/);
});

function diagnosisFixture(diagnosis = '') {
  const f = fixture(), nodes = new Map();
  f.form.querySelector = selector => { if (!nodes.has(selector)) nodes.set(selector,{}); return nodes.get(selector); };
  f.form.elements.diagnosis.value = diagnosis;
  f.form.elements.diagnosis.focus = () => { f.focused = true; };
  f.form.elements.diagnosisChoice = {value:''};
  f.form._assessment = {probableCauses:[{cause:'Capacitor below its rated capacitance'},{cause:'Dirty filter reduces airflow'}]};
  f.ui.bindDiagnosis(f.form);
  return f;
}

test('earlier AI causes populate choices without choosing a diagnosis or confirming inspection automatically', () => {
  const f = diagnosisFixture();
  assert.match(f.form.elements.diagnosisChoice.innerHTML,/Capacitor below/);
  assert.equal(f.form.elements.diagnosis.value,'');assert.equal(f.form.elements.diagnosisChoice.value,'');
  assert.equal(f.form.elements.diagnosisChoice.required,true);assert.equal(f.payload().technicianConfirmed,false);
});

test('explicitly selecting a confirmed cause fills only the diagnosis and carries it into the quotation payload', () => {
  const f = diagnosisFixture(); f.notes.value='Measured the capacitor against its label; actual reading is below rating.';
  f.form.elements.technicianConfirmed.checked=true;
  f.form.elements.diagnosisChoice.value='0';f.form.elements.diagnosisChoice.onchange();
  assert.equal(f.payload().diagnosis,'Capacitor below its rated capacitance');
  assert.equal(f.payload().findings,f.notes.value);assert.equal(f.payload().technicianConfirmed,false);
  assert.equal(f.form.dataset.diagnosisSource,'ai_reviewed');assert.equal(f.form.dataset.dirty,'true');
  assert.equal(f.form.querySelector('[data-manual-diagnosis]').hidden,true);
});

test('saved manual diagnoses survive loading a report and a selected cause remains editable', () => {
  const manual='Wiring fault confirmed by continuity testing.';
  const f=diagnosisFixture(manual);
  assert.equal(f.form.elements.diagnosisChoice.value,'custom');assert.equal(f.payload().diagnosis,manual);
  assert.equal(f.form.querySelector('[data-manual-diagnosis]').hidden,false);
  f.form.elements.diagnosisChoice.value='1';f.form.elements.diagnosisChoice.onchange();
  f.form.querySelector('[data-edit-diagnosis]').onclick();
  assert.equal(f.form.elements.diagnosisChoice.value,'custom');assert.equal(f.focused,true);
  assert.equal(f.payload().diagnosis,'Dirty filter reduces airflow');
});
