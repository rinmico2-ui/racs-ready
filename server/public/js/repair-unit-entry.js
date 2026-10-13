(function () {
  'use strict';
  let drafts = [];
  const esc = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function fields() {
    const quantity = document.getElementById('repairUnitQuantity');
    const problem = document.getElementById('repairProblemDescription');
    return { quantity, problem };
  }
  function capture() {
    document.querySelectorAll('#repairPerUnitDetails [data-unit-index]').forEach(row => {
      drafts[Number(row.dataset.unitIndex)] = { label:row.querySelector('input').value, problemDescription:row.querySelector('textarea').value };
    });
  }
  function render() {
    const { quantity, problem } = fields();
    if (!quantity || !problem) return;
    const count = Math.min(40, Math.max(1, Math.trunc(Number(quantity.value)) || 1));
    let container = document.getElementById('repairPerUnitDetails');
    if (!container) {
      container = document.createElement('div'); container.id = 'repairPerUnitDetails'; container.className = 'ru-entry';
      problem.closest('.mb-3, .form-group, .repair-field')?.append(container);
      if (!container.isConnected) problem.after(container);
    }
    capture();
    if (container.dataset.count === String(count)) return;
    container.dataset.count = String(count);
    container.innerHTML = `<strong>Details for each appliance</strong><p class="small text-muted mb-2">Quantity means physical appliances. Use a label to tell them apart. Change the problem below when an appliance has a different issue.</p><details><summary>Check ${count} appliance${count === 1 ? '' : 's'}</summary>${Array.from({length:count}, (_, index) => `<div data-unit-index="${index}"><label>Appliance ${index+1} label<input maxlength="100" value="${esc(drafts[index]?.label || `Appliance ${index+1}`)}" aria-label="Appliance ${index+1} label"></label><label>Reported problem<textarea maxlength="2000" aria-label="Appliance ${index+1} problem" placeholder="Uses the general problem above when blank">${esc(drafts[index]?.problemDescription)}</textarea></label></div>`).join('')}</details>`;
  }
  window.readRepairUnitDetails = (quantity, problem) => {
    capture();
    return Array.from({length:quantity}, (_,index) => ({unitIndex:index+1, label:drafts[index]?.label || `Appliance ${index+1}`, problemDescription:drafts[index]?.problemDescription?.trim() || problem}));
  };
  window.setRepairUnitDetails = item => {
    drafts = (item?.units || []).map(unit => ({label:unit.label, problemDescription:unit.problemDescription}));
    const container = document.getElementById('repairPerUnitDetails');
    if (container) { container.innerHTML = ''; delete container.dataset.count; }
    render();
  };
  document.addEventListener('input', event => {
    if (event.target.id === 'repairUnitQuantity') render();
    if (event.target.id === 'repairProblemDescription') render();
  });
  document.addEventListener('click', event => { if (event.target.closest('#repairQtyMinus, #repairQtyPlus')) setTimeout(render,0); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
})();
