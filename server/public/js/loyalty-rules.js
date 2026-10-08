(function () {
  'use strict';
  if (!document.querySelector('[data-loyalty-rules]')) return;
  const get = id => document.getElementById(id);
  const form = get('loyaltyRulesForm'), fields = get('loyaltyRulesFields'), host = get('loyaltyRuleCards');
  const state = get('loyaltyRuleState'), feedback = get('loyaltySaveFeedback'), button = get('saveLoyaltyRules'), reload = get('reloadLoyaltyRules');
  let policy, catalogs, saving = false;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const savedTime = value => new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });
  function message(value, failure = false) {
    state.hidden = false; state.className = 'cp-state' + (failure ? ' error' : ''); state.textContent = value;
    feedback.textContent = value; feedback.className = failure ? 'lr-feedback-error' : '';
    feedback.setAttribute('role', failure ? 'alert' : 'status');
  }
  function programStatus() {
    const active = policy.rules.filter(rule => rule.enabled).length;
    get('loyaltyProgramStatus').textContent = `Saved configuration: automatic discounts ${policy.enabled ? 'enabled' : 'disabled'} · ${active} active ${active === 1 ? 'rule' : 'rules'}.`;
  }
  function draftChanged() {
    if (!policy || saving) return;
    button.textContent = 'Save loyalty rules';
    message('Unsaved changes. Save to apply this configuration.');
    reload.hidden = true;
  }
  function options(items, selected) {
    const missing = selected.filter(id => !items.some(item => item.id === id)).map(id => ({ id, name: 'Archived item (' + id.slice(-8) + ')' }));
    return [...items, ...missing].map(item => `<option value="${escape(item.id)}"${selected.includes(item.id) ? ' selected' : ''}>${escape(item.name)}</option>`).join('');
  }
  function addRule(rule) {
    const card = document.createElement('article'); card.className = 'lr-rule'; card.dataset.ruleId = rule.id || crypto.randomUUID();
    card.innerHTML = `<div class="lr-rule-head"><h3>Reward rule</h3><div><label class="lr-toggle"><input type="checkbox" name="enabled" ${rule.enabled ? 'checked' : ''}> Active rule</label><button type="button" class="lr-remove">Remove</button></div></div>
      <div class="lr-rule-grid"><label>Rule name<input name="name" required maxlength="80" value="${escape(rule.name || '')}" placeholder="Repeat service reward"></label>
      <label>Count completed<select name="metric"><option value="bookings">Service bookings</option><option value="orders">Product orders</option><option value="combined">Bookings + orders</option></select></label>
      <label>Completed transactions required<input type="number" name="threshold" min="1" max="10000" step="1" required value="${Number(rule.threshold) || 5}"></label>
      <label>Discount percentage<input type="number" name="discountPercent" min="0.01" max="50" step="0.01" required value="${Number(rule.discountPercent) || 5}"></label>
      <label>Give discount on<select name="appliesTo"><option value="services">Core-service bookings</option><option value="orders">Aircon orders</option><option value="both">Both</option></select></label></div>
      <details><summary>Choose qualifying services and discounted items</summary><div class="lr-rule-grid">
      <label>Bookings that count<select name="qualifyingServiceIds" multiple>${options(catalogs.services, rule.qualifyingServiceIds || [])}</select><small>Leave empty for all completed services. Ignored for order-only qualification.</small></label>
      <label>Services receiving the discount<select name="eligibleServiceIds" multiple>${options(catalogs.services, rule.eligibleServiceIds || [])}</select><small>Leave empty for all eligible standard core services.</small></label>
      <label>Products receiving the discount<select name="eligibleProductIds" multiple>${options(catalogs.products, rule.eligibleProductIds || [])}</select><small>Leave empty for all aircon products. Hold Ctrl / Command to select or clear several items.</small></label></div></details><p class="lr-preview"></p>`;
    card.querySelector('[name=metric]').value = rule.metric || 'bookings'; card.querySelector('[name=appliesTo]').value = rule.appliesTo || 'services';
    const preview = () => {
      const control = name => card.querySelector(`[name=${name}]`);
      card.querySelector('.lr-preview').textContent = `After ${control('threshold').value} completed ${control('metric').selectedOptions[0].textContent.toLowerCase()}, give ${control('discountPercent').value}% off future eligible ${control('appliesTo').selectedOptions[0].textContent.toLowerCase()}.`;
    };
    card.addEventListener('input', preview); card.addEventListener('change', preview); preview();
    card.querySelector('.lr-remove').addEventListener('click', () => { if (saving) return; card.remove(); draftChanged(); message('Rule removed from the draft. Save to apply the change.'); });
    host.append(card);
  }
  async function request(options = {}) {
    const response = await fetch('/api/admin/customers/loyalty-rules', { credentials: 'same-origin', cache: 'no-store', ...options, headers: { Accept: 'application/json', ...options.headers } });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const err = new Error(response.status === 401 ? 'Your session has expired. Sign in again before saving.'
        : response.status === 403 ? 'Your account does not have permission to manage loyalty rules.'
          : data?.error || 'Unable to access loyalty rules. Please try again.');
      err.status = response.status; throw err;
    }
    if (!data?.policy || !Array.isArray(data.policy.rules) || typeof data.policy.revision !== 'string') throw new Error('The server returned an invalid loyalty configuration. Please reload the page.');
    return data;
  }
  async function load() {
    if (saving) return;
    fields.disabled = true; button.disabled = true; reload.hidden = true;
    message('Loading loyalty rules…');
    try {
      const data = await request();
      policy = data.policy; catalogs = { services: data.services || [], products: data.products || [] };
      get('loyaltyEnabled').checked = policy.enabled;
      host.replaceChildren(); policy.rules.forEach(addRule); programStatus();
      get('loyaltySavedAt').textContent = policy.updatedAt ? 'Last saved ' + savedTime(policy.updatedAt) : 'Changes apply to new checkouts after saving.';
      message(policy.rules.length ? 'Saved rules loaded. Edit and save to apply changes.' : 'No reward rules configured. Add a rule, activate it, and enable automatic discounts when ready.');
      fields.disabled = false; button.disabled = false; button.textContent = 'Save loyalty rules';
    } catch (err) { message(err.message || 'Unable to load loyalty rules.', true); reload.textContent = 'Retry loading rules'; reload.hidden = false; }
  }
  get('addLoyaltyRule').addEventListener('click', () => {
    if (!catalogs || fields.disabled || saving) return;
    if (host.children.length >= 12) return message('You can configure up to 12 rules.', true);
    addRule({ enabled: false }); draftChanged();
  });
  form.addEventListener('input', draftChanged); form.addEventListener('change', draftChanged);
  reload.addEventListener('click', load);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    if (!policy || fields.disabled) return message('Wait for loyalty rules to load before saving. Use Retry if loading failed.', true);
    // novalidate lets this handler provide feedback next to Save as well as
    // the browser's validation message beside the specific invalid field.
    if (!form.checkValidity()) { message('Check the rule names, completed transaction requirements, and discount percentages before saving.', true); form.reportValidity(); return; }
    saving = true;
    try {
      const rules = [...host.children].map(card => {
        const control = name => card.querySelector(`[name=${name}]`);
        const ids = name => [...control(name).selectedOptions].map(option => option.value);
        const name = control('name').value.trim();
        if (!name) throw new Error('Enter a name for every reward rule.');
        return { id: card.dataset.ruleId, name, enabled: control('enabled').checked, metric: control('metric').value,
          threshold: Number(control('threshold').value), discountPercent: Number(control('discountPercent').value), appliesTo: control('appliesTo').value,
          qualifyingServiceIds: ids('qualifyingServiceIds'), eligibleServiceIds: ids('eligibleServiceIds'), eligibleProductIds: ids('eligibleProductIds') };
      });
      const enabled = get('loyaltyEnabled').checked;
      if (enabled && !rules.some(rule => rule.enabled)) throw new Error('Activate at least one reward rule before enabling automatic loyalty discounts.');
      fields.disabled = true; button.disabled = true; button.textContent = 'Saving…';
      form.setAttribute('aria-busy', 'true'); message('Saving loyalty rules…');
      const data = await request({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, rules, expectedRevision: policy.revision }) });
      policy = data.policy; programStatus();
      message(policy.enabled ? 'Saved successfully. Automatic discounts are enabled for eligible new checkouts.' : 'Saved successfully. Automatic discounts are disabled; enable the program and save to apply rewards.');
      get('loyaltySavedAt').textContent = 'Saved ' + savedTime(policy.updatedAt); button.textContent = 'Saved';
    } catch (err) {
      message(err.message || 'Unable to save loyalty rules. Your draft has been kept.', true); button.textContent = 'Save loyalty rules';
      if (err.status === 409) { reload.textContent = 'Reload saved rules (replace draft)'; reload.hidden = false; }
    } finally {
      saving = false; fields.disabled = false; button.disabled = false; form.setAttribute('aria-busy', 'false');
    }
  });
  load();
})();
