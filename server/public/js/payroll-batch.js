(function () {
  'use strict';
  var form = document.getElementById('payrollBatchForm'); if (!form) return;
  var templates = [], staff = [], token = '', busy = false;
  var review = document.getElementById('batchPayrollReview'), create = document.getElementById('batchPayrollCreate'), preview = document.getElementById('batchPayrollPreview');
  var feedback = document.getElementById('payrollBatchFeedback');
  function invalidate() { token = ''; create.disabled = true; preview.replaceChildren(); FormFeedback.clear(form); }
  form.addEventListener('input', invalidate); form.addEventListener('change', invalidate);
  function notice(text) { feedback.textContent = text; feedback.hidden = !text; }
  function money(value) { return 'PHP ' + Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function today() { var parts = new Intl.DateTimeFormat('en', { timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit' }).formatToParts(new Date()); var p = Object.fromEntries(parts.map(function (v) { return [v.type, v.value]; })); return p.year+'-'+p.month+'-'+p.day; }
  function addOption(select, value, text) { var option = document.createElement('option'); option.value = value; option.textContent = text; select.appendChild(option); }
  function templateSelects() {
    ['Allowance', 'Deduction'].forEach(function (part) {
      var select = document.getElementById('payroll' + part + 'Template'); if (!select) return;
      select.replaceChildren(); addOption(select, '', 'Choose a template');
      templates.filter(function (t) { return t.kind === part.toLowerCase(); }).forEach(function (t) { addOption(select, t._id, t.name + (t.amount > 0 ? ' — ' + money(t.amount) : ' — enter amount')); });
    });
  }
  async function loadTemplates() {
    var data = await RACSRequest.json('/api/payroll/templates'); templates = data.templates || []; templateSelects();
    var list = document.getElementById('batchTemplateList'); list.replaceChildren();
    templates.filter(function (t) { return t.amount > 0; }).forEach(function (t) { checkbox(list, 'template', t._id, t.name + ' (' + t.kind + ') — ' + money(t.amount)); });
    if (!list.children.length) list.textContent = 'No saved amounts yet. You can create the batch without templates or save a template first.';
  }
  function checkbox(container, kind, id, label) {
    var column = document.createElement('div'); column.className = 'col-md-6'; var wrapper = document.createElement('label'); wrapper.className = 'form-check d-flex gap-2 p-2 border rounded';
    var input = document.createElement('input'); input.type = 'checkbox'; input.className = 'form-check-input ms-0'; input.dataset.batchKind = kind; input.value = id;
    var text = document.createElement('span'); text.textContent = label; wrapper.append(input, text); column.appendChild(wrapper); container.appendChild(column);
  }
  document.getElementById('btnBatchPayroll').addEventListener('click', async function () {
    invalidate(); form.reset(); var date = today(); ['batchPeriodStart','batchPeriodEnd','batchPayDate'].forEach(function (id) { document.getElementById(id).value = date; });
    bootstrap.Modal.getOrCreateInstance(document.getElementById('payrollBatchModal')).show();
    var list = document.getElementById('batchStaffList'); list.textContent = 'Loading employees…'; review.disabled = true;
    try {
      var data = await RACSRequest.json('/api/payroll/staff'); staff = data.staff || []; list.replaceChildren();
      staff.forEach(function (person) { checkbox(list, 'employee', person._id, [person.firstName,person.lastName].filter(Boolean).join(' ') + ' (' + person.role + ')'); });
      await loadTemplates();
    } catch (error) { FormFeedback.show(form, error); }
    finally { review.disabled = false; }
  });
  document.getElementById('batchSelectStaff').addEventListener('click', function () { var inputs = form.querySelectorAll('[data-batch-kind="employee"]'); var clear = Array.from(inputs).some(function (input) { return input.checked; }); inputs.forEach(function (input, i) { input.checked = !clear && i < 25; }); invalidate(); });
  function payload() { var data = Object.fromEntries(new FormData(form)); data.employeeIds = Array.from(form.querySelectorAll('[data-batch-kind="employee"]:checked')).map(function (input) { return input.value; }); data.templateIds = Array.from(form.querySelectorAll('[data-batch-kind="template"]:checked')).map(function (input) { return input.value; }); return data; }
  function displayRows(rows, summary) {
    preview.replaceChildren(); var text = document.createElement('p'); text.className = 'alert alert-info'; text.textContent = summary; preview.appendChild(text);
    var table = document.createElement('table'); table.className = 'table table-sm'; var header = table.createTHead().insertRow();
    ['Employee','Basic pay','Net pay','Result / attendance notes'].forEach(function (v) { var cell = document.createElement('th'); cell.textContent = v; header.appendChild(cell); });
    var body = table.createTBody(); rows.forEach(function (row) { var person = staff.find(function (p) { return p._id === row.employee; }); var line = body.insertRow(); [row.name || (person ? person.firstName + ' ' + person.lastName : 'Staff member'), row.basicPay === undefined ? '' : money(row.basicPay), row.netPay === undefined ? '' : money(row.netPay), row.error || (row.success ? 'Draft created' : (row.warnings || []).join('; ') || 'Ready')].forEach(function (v) { line.insertCell().textContent = v; }); });
    var wrapper = document.createElement('div'); wrapper.className = 'table-responsive'; wrapper.appendChild(table); preview.appendChild(wrapper);
  }
  async function submit(mode) {
    if (busy || !form.reportValidity()) return;
    var data = payload(); if (!data.employeeIds.length || data.employeeIds.length > 25) { FormFeedback.show(form, new Error('Select between 1 and 25 employees.')); return; }
    if (mode === 'create' && !token) return;
    busy = true; review.disabled = create.disabled = true; FormFeedback.clear(form); if (token) data.previewToken = token;
    var button = mode === 'preview' ? review : create, original = button.textContent; button.textContent = mode === 'preview' ? 'Calculating…' : 'Creating drafts…';
    form.querySelectorAll('input,select,textarea,button').forEach(function (input) { input.disabled = true; });
    try {
      var result = await RACSRequest.json('/api/payroll/bulk/' + mode, { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),timeoutMs:120000 });
      if (mode === 'preview') { token = result.previewToken || ''; displayRows(result.drafts || [], result.ready + ' employees ready. Total net pay: ' + money(result.netPay)); }
      else { token = ''; displayRows(result.results || [], result.created + ' drafts created. ' + result.failed + ' employees need attention.'); notice(result.message); await window._pw.refreshRecords(); }
    } catch (error) { FormFeedback.show(form, error); if (mode === 'create') token = ''; }
    finally { busy = false; form.querySelectorAll('input,select,textarea,button').forEach(function (input) { input.disabled = false; }); review.disabled = false; create.disabled = !token; button.textContent = original; }
  }
  review.addEventListener('click', function () { submit('preview'); }); create.addEventListener('click', function () { submit('create'); });
  async function savedTemplates() {
    await loadTemplates(); var target = document.getElementById('payrollSavedTemplates'); target.replaceChildren();
    var table = document.createElement('table'); table.className = 'table table-sm'; var body = table.createTBody();
    templates.filter(function (t) { return !t.builtin; }).forEach(function (t) {
      var row = body.insertRow();
      var name = document.createElement('input'); name.className='form-control form-control-sm'; name.value=t.name; name.maxLength=80; name.required=true; name.setAttribute('aria-label','Template name'); row.insertCell().appendChild(name);
      var kind = document.createElement('select'); kind.className='form-select form-select-sm'; kind.setAttribute('aria-label','Template type'); addOption(kind,'allowance','Allowance'); addOption(kind,'deduction','Deduction'); kind.value=t.kind; row.insertCell().appendChild(kind);
      var amount = document.createElement('input'); amount.className='form-control form-control-sm'; amount.type='number'; amount.min='0'; amount.max='10000000'; amount.step='0.01'; amount.value=t.amount; amount.required=true; amount.setAttribute('aria-label','Template amount in PHP'); row.insertCell().appendChild(amount);
      var actions = row.insertCell(); actions.className='text-nowrap';
      var save = document.createElement('button'); save.type='button';save.className='btn btn-sm btn-outline-primary me-2';save.textContent='Save';actions.appendChild(save);
      var button = document.createElement('button'); button.type='button';button.className='btn btn-sm btn-outline-danger';button.textContent='Archive';actions.appendChild(button);
      save.addEventListener('click', async function () {
        if(!name.reportValidity()||!amount.reportValidity())return;
        save.disabled=button.disabled=true;
        try { await RACSRequest.json('/api/payroll/templates/'+encodeURIComponent(t._id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name.value,kind:kind.value,amount:amount.value})});invalidate();await savedTemplates(); }
        catch(error){FormFeedback.show(document.getElementById('payrollTemplateForm'),error);save.disabled=button.disabled=false;}
      });
      button.addEventListener('click', async function () { button.disabled = true; try { await RACSRequest.json('/api/payroll/templates/' + encodeURIComponent(t._id), { method:'DELETE' }); invalidate(); await savedTemplates(); } catch (error) { FormFeedback.show(document.getElementById('payrollTemplateForm'), error); button.disabled = false; } });
    }); target.appendChild(table);
    if (!body.rows.length) target.textContent = 'No custom templates saved yet.';
  }
  document.getElementById('btnPayrollTemplates').addEventListener('click', async function () {
    bootstrap.Modal.getOrCreateInstance(document.getElementById('payrollTemplateModal')).show();
    try { await savedTemplates(); } catch (error) { FormFeedback.show(document.getElementById('payrollTemplateForm'), error); }
  });
  document.getElementById('payrollTemplateForm').addEventListener('submit', async function (event) {
    event.preventDefault(); var target = event.currentTarget; if (!target.reportValidity()) return;
    FormFeedback.clear(target); var button = target.querySelector('button[type="submit"]'); button.disabled = true;
    try { await RACSRequest.json('/api/payroll/templates', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(target))) }); target.reset(); invalidate(); await savedTemplates(); }
    catch (error) { FormFeedback.show(target, error); }
    finally { button.disabled = false; }
  });
  ['Allowance','Deduction'].forEach(function (part) {
    var button = document.getElementById('apply' + part + 'Template');
    button.addEventListener('click', function () { var id = document.getElementById('payroll' + part + 'Template').value; var template = templates.find(function (t) { return t._id === id; }); if (template) window._pw.applyTemplate(part.toLowerCase(), template.name, template.amount); });
  });
  loadTemplates().catch(function (error) { notice(error.message); });
})();
