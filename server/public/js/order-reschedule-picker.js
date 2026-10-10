(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OrderReschedulePicker = api.OrderReschedulePicker;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function dateFromKey(key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key || ''))) return null;
    const value = new Date(key + 'T00:00:00');
    if (Number.isNaN(value.getTime())) return null;
    const normalized = value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0');
    return normalized === key ? value : null;
  }

  function normalizeAvailableDates(rows) {
    const dates = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!dateFromKey(row?.date)) continue;
      const slots = (Array.isArray(row.timeSlots) ? row.timeSlots : [])
        .filter(slot => typeof (slot?.time || slot?.startTime) === 'string' && (slot.time || slot.startTime).trim() && slot.available !== false && slot.isPast !== true)
        .map(slot => ({ time: String(slot.time || slot.startTime).trim(), label: String(slot.label || slot.time || slot.startTime).trim() }));
      const count = Number(row.availableSlots);
      const available = row.available === true || (Number.isFinite(count) && count > 0);
      dates.set(row.date, { date: row.date, available: available && (slots.length > 0 || count > 0), availableSlots: Number.isFinite(count) ? count : slots.length, timeSlots: slots });
    }
    return dates;
  }

  function displayTime(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return String(value || '');
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return String(value || '');
    return String(hour % 12 || 12) + ':' + match[2] + (hour >= 12 ? ' PM' : ' AM');
  }

  class OrderReschedulePicker {
    constructor(rootElement, dateInput, timeInput, onChange, loadTimeSlots) {
      this.root = rootElement;
      this.dateInput = dateInput;
      this.timeInput = timeInput;
      this.onChange = onChange || function () {};
      this.loadTimeSlots = loadTimeSlots || null;
      this.requestGeneration = 0;
      this.dates = new Map();
      this.activeMonth = new Date();
      this.activeMonth.setDate(1);
      this.selectedDate = '';
      this.selectedTime = '';
      this.root.innerHTML = '<div class="ord-rs-head"><button type="button" class="ord-rs-nav" data-month="prev" aria-label="Previous month"><i class="bi bi-chevron-left" aria-hidden="true"></i></button><strong data-month-label></strong><button type="button" class="ord-rs-nav" data-month="next" aria-label="Next month"><i class="bi bi-chevron-right" aria-hidden="true"></i></button></div><p class="ord-rs-hint">Choose an open date, then select a start time.</p><div class="ord-rs-weekdays" aria-hidden="true"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div><div class="ord-rs-grid" data-date-grid></div><div class="ord-rs-legend"><span>Open</span><span>Few left</span><span>Full or closed</span></div><section class="ord-rs-time-section" data-time-section hidden><div class="ord-rs-time-head"><strong>Choose a start time</strong><span data-time-date></span></div><div class="ord-rs-time-grid" data-time-grid aria-live="polite"></div><div class="ord-rs-selection" data-selection hidden role="status" aria-live="polite"></div></section>';
      this.grid = this.root.querySelector('[data-date-grid]');
      this.timeGrid = this.root.querySelector('[data-time-grid]');
      this.timeSection = this.root.querySelector('[data-time-section]');
      this.monthLabel = this.root.querySelector('[data-month-label]');
      this.timeDate = this.root.querySelector('[data-time-date]');
      this.selection = this.root.querySelector('[data-selection]');
      this.prev = this.root.querySelector('[data-month="prev"]');
      this.next = this.root.querySelector('[data-month="next"]');
      this.root.addEventListener('click', event => {
        const monthButton = event.target.closest('[data-month]');
        if (monthButton && this.root.contains(monthButton) && !monthButton.disabled) {
          this.changeMonth(monthButton.dataset.month === 'prev' ? -1 : 1);
          return;
        }
        const dateButton = event.target.closest('[data-reschedule-date]');
        if (dateButton && this.root.contains(dateButton)) {
          this.selectDate(dateButton.dataset.rescheduleDate);
          return;
        }
        const timeButton = event.target.closest('[data-reschedule-time]');
        if (timeButton && this.root.contains(timeButton)) this.selectTime(timeButton.dataset.rescheduleTime);
      });
      this.render();
    }

    reset() {
      this.requestGeneration++;
      this.dates = new Map();
      this.selectedDate = '';
      this.selectedTime = '';
      this.dateInput.value = '';
      this.timeInput.value = '';
      this.timeSection.hidden = true;
      this.selection.hidden = true;
      this.activeMonth = new Date();
      this.activeMonth.setDate(1);
      this.render();
      this.onChange();
    }

    setDates(rows) {
      this.requestGeneration++;
      this.dates = normalizeAvailableDates(rows);
      this.selectedDate = '';
      this.selectedTime = '';
      this.dateInput.value = '';
      this.timeInput.value = '';
      this.timeSection.hidden = true;
      this.selection.hidden = true;
      const firstOpen = [...this.dates.values()].find(row => row.available);
      if (firstOpen) {
        const date = dateFromKey(firstOpen.date);
        this.activeMonth = new Date(date.getFullYear(), date.getMonth(), 1);
      }
      this.render();
      this.onChange();
      return Boolean(firstOpen);
    }

    changeMonth(offset) {
      const next = new Date(this.activeMonth.getFullYear(), this.activeMonth.getMonth() + offset, 1);
      const keys = [...this.dates.keys()].sort();
      const first = keys.length ? dateFromKey(keys[0]) : null;
      const last = keys.length ? dateFromKey(keys[keys.length - 1]) : null;
      if (!first || !last || next < new Date(first.getFullYear(), first.getMonth(), 1)
        || next > new Date(last.getFullYear(), last.getMonth(), 1)) return;
      this.activeMonth = next;
      this.render();
    }

    async selectDate(key) {
      const row = this.dates.get(key);
      if (!row?.available) return;
      const requestGeneration = ++this.requestGeneration;
      this.selectedDate = key;
      this.selectedTime = '';
      this.dateInput.value = key;
      this.timeInput.value = '';
      if (this.loadTimeSlots) row.timeSlots = [];
      this.render();
      this.onChange();
      if (!this.loadTimeSlots) return;
      this.timeGrid.textContent = 'Loading available times...';
      try {
        const slots = await this.loadTimeSlots(key);
        if (requestGeneration !== this.requestGeneration) return;
        const normalized = normalizeAvailableDates([{ date: key, available: true, timeSlots: slots }]).get(key);
        row.timeSlots = normalized?.timeSlots || [];
        if (!row.timeSlots.length) {
          row.available = false;
          this.selectedDate = '';
          this.dateInput.value = '';
          this.onChange();
        }
        this.render();
        if (!row.timeSlots.length) {
          this.timeSection.hidden = false;
          this.timeGrid.textContent = 'No start times remain for this date. Choose another open date.';
        }
      } catch (error) {
        if (requestGeneration !== this.requestGeneration) return;
        this.timeGrid.textContent = 'Could not check available times. Select the date to try again.';
      }
    }

    selectTime(time) {
      const row = this.dates.get(this.selectedDate);
      if (!row?.available || !row.timeSlots.some(slot => slot.time === time)) return;
      this.selectedTime = time;
      this.timeInput.value = time;
      this.renderTimes();
      this.onChange();
    }

    render() {
      const year = this.activeMonth.getFullYear();
      const month = this.activeMonth.getMonth();
      this.monthLabel.textContent = this.activeMonth.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
      const keys = [...this.dates.keys()].sort();
      const first = keys.length ? dateFromKey(keys[0]) : null;
      const last = keys.length ? dateFromKey(keys[keys.length - 1]) : null;
      this.prev.disabled = !first || this.activeMonth <= new Date(first.getFullYear(), first.getMonth(), 1);
      this.next.disabled = !last || this.activeMonth >= new Date(last.getFullYear(), last.getMonth(), 1);
      this.grid.replaceChildren();
      const firstWeekday = new Date(year, month, 1).getDay();
      for (let index = 0; index < firstWeekday; index++) {
        const blank = document.createElement('span');
        blank.className = 'ord-rs-empty';
        this.grid.appendChild(blank);
      }
      const dayCount = new Date(year, month + 1, 0).getDate();
      for (let day = 1; day <= dayCount; day++) {
        const date = new Date(year, month, day);
        const key = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
        const row = this.dates.get(key);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ord-rs-day' + (row?.available ? (row.availableSlots <= 3 ? ' is-limited' : ' is-open') : '') + (key === this.selectedDate ? ' is-selected' : '');
        const dayNumber = document.createElement('span');
        dayNumber.textContent = String(day);
        button.appendChild(dayNumber);
        if (row?.available) {
          const status = document.createElement('small');
          status.textContent = row.availableSlots <= 3 ? 'Few left' : 'Open';
          button.appendChild(status);
        }
        button.disabled = !row?.available;
        button.dataset.rescheduleDate = key;
        button.setAttribute('aria-label', date.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + (row?.available ? ', available' : ', unavailable'));
        button.setAttribute('aria-pressed', key === this.selectedDate ? 'true' : 'false');
        this.grid.appendChild(button);
      }
      this.renderTimes();
    }

    renderTimes() {
      const row = this.dates.get(this.selectedDate);
      this.timeSection.hidden = !row?.available;
      this.timeGrid.replaceChildren();
      this.selection.hidden = !this.selectedTime;
      if (!row?.available) return;
      this.timeDate.textContent = dateFromKey(this.selectedDate).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' });
      for (const slot of row.timeSlots) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ord-rs-time' + (slot.time === this.selectedTime ? ' is-selected' : '');
        button.textContent = displayTime(slot.label);
        const status = document.createElement('small');
        status.textContent = slot.time === this.selectedTime ? 'Selected' : 'Available';
        button.appendChild(status);
        button.dataset.rescheduleTime = slot.time;
        button.setAttribute('aria-pressed', slot.time === this.selectedTime ? 'true' : 'false');
        this.timeGrid.appendChild(button);
      }
      if (this.selectedTime) this.selection.textContent = 'Selected: ' + this.timeDate.textContent + ' · ' + displayTime(this.selectedTime);
    }
  }

  return { OrderReschedulePicker, normalizeAvailableDates, dateFromKey };
});
