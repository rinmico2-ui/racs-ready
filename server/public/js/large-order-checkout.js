(function () {
  'use strict';
  class LargeOrderCheckout {
    constructor(options) {
      this.options = options; this.active = false; this.version = 0; this.verdict = null;
      this.panel = document.getElementById('orderProjectWindow');
      this.start = document.getElementById('orderProjectStart'); this.end = document.getElementById('orderProjectEnd');
      this.status = document.getElementById('orderProjectWindowStatus'); this.retry = document.getElementById('orderProjectWindowRetry');
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const tomorrow = new Date(today + 'T00:00:00Z'); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1); this.start.min = tomorrow.toISOString().slice(0, 10);
      [this.start, this.end].forEach(input => input.addEventListener('input', () => this.changed()));
      this.retry.addEventListener('click', () => this.check());
    }
    setMode(fulfillment, items, thresholdHours) {
      this.items = items; this.units = items.reduce((sum, item) => sum + Number(item.quantity), 0);
      const active = fulfillment === 'delivery_installation' && (this.units >= 8 || this.units > (Number(thresholdHours) || 8));
      const changed = this.active !== active; this.active = active;
      this.panel.hidden = !active; document.getElementById('orderStandardSchedule').hidden = active;
      if (active) {
        document.getElementById('orderProjectUnits').textContent = this.units + ' aircons';
        document.getElementById('wizardTimeSlot').value = ''; document.getElementById('wizardDate').value = this.start.value;
        if (changed) this.changed();
      } else {
        clearTimeout(this.timer); this.version++; this.controller?.abort();
        if (changed) document.getElementById('wizardDate').value = '';
      }
    }
    reset() {
      clearTimeout(this.timer); this.controller?.abort(); this.version++; this.verdict = null;
      this.start.value = ''; this.end.value = ''; this.end.min = this.start.min;
      this.retry.hidden = true; this.status.textContent = 'Choose both dates to check the available installation capacity.';
    }
    selection() { return this.active ? { preferredStartDate: this.start.value, preferredCompletionDeadline: this.end.value } : null; }
    restore(selection) {
      if (!selection) return;
      this.start.value = selection.preferredStartDate || ''; this.end.value = selection.preferredCompletionDeadline || '';
      if (this.active) this.changed();
    }
    changed() {
      clearTimeout(this.timer); this.controller?.abort(); this.version++; this.verdict = null; this.retry.hidden = true;
      this.end.min = this.start.value || this.start.min;
      if (this.active) document.getElementById('wizardDate').value = this.start.value;
      this.status.textContent = 'Choose both dates to check the available installation capacity.'; this.options.onChange();
      if (this.validRange()) this.timer = setTimeout(() => this.check(), 250);
    }
    validRange() { return window.OrderCheckoutErrors.isFutureDate(this.start.value) && this.end.value > this.start.value && new Date(this.end.value) - new Date(this.start.value) <= 366 * 86400000; }
    issue() {
      if (!this.active) return null;
      const base = { step: 2, title: 'Choose an Installation Window', confirmButtonText: 'Review dates', focusSelector: '#orderProjectWindow' };
      if (!this.validRange()) return { ...base, message: 'Choose a future start date and a later finish-by date within one year.' };
      if (this.verdict?.sufficient !== true) return { ...base, message: this.status.textContent || 'Wait for the capacity check or choose a wider date range.' };
      return null;
    }
    async check() {
      if (!this.active || !this.validRange()) return;
      this.controller?.abort(); this.controller = new AbortController(); const version = ++this.version; this.verdict = null;
      this.status.textContent = 'Checking technician capacity, working days and existing schedules...'; this.retry.hidden = true; this.options.onChange();
      try {
        const result = await window.RACSRequest.json('/api/orders/installation-window', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: this.controller.signal,
          body: JSON.stringify({ items: this.items.map(item => ({ inventoryId: String(item.inventoryId?._id || item.inventoryId), quantity: Number(item.quantity) })), projectScheduling: this.selection() }) });
        if (version !== this.version || !this.active) return;
        this.verdict = result;
        this.status.textContent = result.sufficient === true ? 'Estimated capacity is available. Staff will confirm your daily installation plan.'
          : 'This window has insufficient capacity. Choose a later finish-by date.' + (result.earliestCompletionDate ? ' Earliest estimated finish: ' + result.earliestCompletionDate + '.' : '');
      } catch (error) {
        if (version !== this.version || error.name === 'AbortError' || !this.active) return;
        this.status.textContent = error.message || 'Could not check the installation dates. Please try again.'; this.retry.hidden = false;
      } finally { if (version === this.version) this.options.onChange(); }
    }
  }
  window.LargeOrderCheckout = LargeOrderCheckout;
})();
