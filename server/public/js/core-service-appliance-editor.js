(function () {
  'use strict';
  const kinds = ['refrigerator', 'freezer'];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function mount(form) {
    const A = window.ApplianceServices;
    const field = name => form.elements.namedItem(name);
    const section = kind => form.querySelector(`[data-appliance="${kind}"]`);
    function tab(key, focus = false) {
      form.querySelectorAll('[data-editor-panel]').forEach(panel => { panel.hidden = panel.dataset.editorPanel !== key; });
      form.querySelectorAll('[data-editor-tab]').forEach(button => {
        const active = button.dataset.editorTab === key;
        button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
        if (active && focus) button.focus();
      });
      form.querySelector('.core-modal-body').scrollTop = 0;
    }
    function syncAircon() {
      form.querySelectorAll('#airconConfigSection input, #airconConfigSection select, #airconConfigSection button').forEach(input => { input.disabled = !field('isAirconService').checked; });
    }
    function checkRows(kind) {
      const node = section(kind), hpMode = field(kind + 'Mode').value === 'hp', enabled = field(kind + 'Enabled').checked;
      const seen = new Set();
      node.querySelectorAll('[data-hp-row]').forEach(row => {
        const hpInput = row.querySelector('[data-tier="hp"]'), hp = A.parseHp(hpInput.value);
        hpInput.setCustomValidity(!Number.isFinite(hp) ? 'Enter a positive HP, such as 1/8 or 0.125.' : seen.has(hp) ? 'This compressor HP already has a price. Use a different size.' : '');
        seen.add(hp);
      });
      field(kind + 'Mode').setCustomValidity(enabled && hpMode && !node.querySelector('[data-hp-row]') ? 'Add at least one compressor HP price.' : '');
    }
    function sync(kind) {
      const node = section(kind), enabled = field(kind + 'Enabled').checked, hpMode = field(kind + 'Mode').value === 'hp';
      node.classList.toggle('is-enabled', enabled);
      node.querySelector('[data-off-note]').hidden = enabled;
      node.querySelector('[data-family-settings]').hidden = !enabled;
      node.querySelector('[data-family-settings]').disabled = !enabled;
      node.querySelector('[data-fixed-fields]').hidden = hpMode;
      node.querySelector('[data-hp-fields]').hidden = !hpMode;
      ['Price', 'Minutes'].forEach(suffix => { field(kind + suffix).disabled = !enabled || hpMode; field(kind + suffix).required = enabled && !hpMode; });
      node.querySelectorAll('[data-hp-row] input').forEach(input => { input.disabled = !enabled || !hpMode; input.required = enabled && hpMode; });
      checkRows(kind);
    }
    function add(kind, tier = {}) {
      const row = document.createElement('div'); row.className = 'cse-hp-row'; row.dataset.hpRow = '';
      row.innerHTML = `<label>Compressor HP<input class="form-control" data-tier="hp" type="text" maxlength="20" placeholder="e.g. 1/8" value="${escape(A.formatHp(tier.hp))}"></label><label>Price per appliance (PHP)<input class="form-control" data-tier="price" type="number" min="0" max="1000000" step="0.01" placeholder="0.00" value="${escape(tier.price)}"></label><label>Work time (minutes)<input class="form-control" data-tier="minutes" type="number" min="1" max="10080" step="1" placeholder="60" value="${escape(tier.durationMinutes)}"></label><button type="button" class="cse-remove" data-remove-hp aria-label="Remove compressor HP price"><i class="bi bi-trash3" aria-hidden="true"></i><span>Remove</span></button>`;
      section(kind).querySelector('[data-hp-rows]').appendChild(row); sync(kind);
      return row;
    }
    form.addEventListener('click', event => {
      const button = event.target.closest('[data-editor-tab]');
      if (button && form.contains(button)) tab(button.dataset.editorTab);
      const node = event.target.closest('[data-appliance]');
      if (!node || !form.contains(node)) return;
      if (event.target.closest('[data-add-hp]')) add(node.dataset.appliance).querySelector('input').focus();
      const remove = event.target.closest('[data-remove-hp]');
      if (remove) { const row = remove.closest('[data-hp-row]'); row.remove(); sync(node.dataset.appliance); node.querySelector('[data-add-hp]').focus(); }
    });
    form.addEventListener('keydown', event => {
      if (!event.target.matches('[data-editor-tab]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const buttons = [...form.querySelectorAll('[data-editor-tab]')], index = buttons.indexOf(event.target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      tab(buttons[next].dataset.editorTab, true);
    });
    form.addEventListener('change', event => { const node = event.target.closest('[data-appliance]'); if (node) sync(node.dataset.appliance); });
    form.addEventListener('input', event => { const node = event.target.closest('[data-appliance]'); if (node) checkRows(node.dataset.appliance); });
    function set(profiles) {
      kinds.forEach(kind => {
        const profile = profiles.find(row => row.kind === kind) || {};
        field(kind + 'Enabled').checked = !!profile.enabled;
        field(kind + 'Mode').value = profile.pricingMode || 'fixed';
        field(kind + 'Price').value = profile.unitPrice ?? '';
        field(kind + 'Minutes').value = profile.durationMinutes ?? '';
        section(kind).querySelector('[data-hp-rows]').replaceChildren();
        (profile.hpPricing || []).forEach(tier => add(kind, tier)); sync(kind);
      });
    }
    function get() {
      return kinds.map(kind => ({ kind, enabled: field(kind + 'Enabled').checked, pricingMode: field(kind + 'Mode').value,
        unitPrice: field(kind + 'Price').value === '' ? undefined : Number(field(kind + 'Price').value),
        durationMinutes: field(kind + 'Minutes').value === '' ? undefined : Number(field(kind + 'Minutes').value),
        hpPricing: [...section(kind).querySelectorAll('[data-hp-row]')].map(row => ({ hp: A.parseHp(row.querySelector('[data-tier="hp"]').value), price: row.querySelector('[data-tier="price"]').value === '' ? null : Number(row.querySelector('[data-tier="price"]').value), durationMinutes: Number(row.querySelector('[data-tier="minutes"]').value) })).filter(row => Number.isFinite(row.hp) && row.price !== null && row.durationMinutes > 0),
      }));
    }
    function validate() {
      kinds.forEach(sync); syncAircon();
      const invalid = [...form.elements].find(input => input.willValidate && !input.validity.valid);
      if (!invalid) return true;
      const panel = invalid.closest('[data-editor-panel]'); if (panel) tab(panel.dataset.editorPanel);
      invalid.focus(); invalid.reportValidity(); return false;
    }
    return { set, get, tab, validate, syncAircon };
  }
  window.CoreServiceApplianceEditor = { mount };
})();
