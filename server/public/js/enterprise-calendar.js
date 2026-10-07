/**
 * Enterprise Calendar Module
 * Capacity-based scheduling with distinct holiday/non-working visuals.
 *
 * Supports three scheduling modes:
 *  - "appointment" (default): date + time-slot selection for standard jobs.
 *  - "project": large-scale work. The customer chooses a start date and
 *    latest acceptable finish date; operations confirms the work schedule.
 *  - "preferred": date-only request for a quote, without checking or reserving slots.
 */

"use strict";

const EnterpriseCalendar = (() => {
  function calendarDebug(...args) {
    if (window.RACS_BOOKING_DEBUG === true) console.debug('[Calendar]', ...args);
  }

  let _currentMonth = null;
  let _selectedDate = null;
  let _selectedSlot = null;
  let _scheduleData = null;
  let _holidaysData = null;
  let _projectsData = []; // active commercial-project bars
  let _projectCapacityData = null; // per-date tech capacity for project mode
  let _serviceId = null;
  let _technicianId = null;
  let _duration = 90;
  let _hasExplicitDuration = false;
  let _quantity = 1;
  let _travelTime = 30;
  let _onSelectCb = null;
  let _nextStep = 5;
  let _showCommercialProjects = true;
  let _timeSlotRequestId = 0;
  let _root = document;
  let _syncGlobalState = true;

  // Large-scale / project mode
  let _mode = "appointment"; // "appointment" | "project" | "preferred"
  let _totalEstimatedMinutes = 0;
  let _isLargeProject = false;
  let _selectedEndDate = null;
  let _selectingEndDate = false; // true when waiting for end-date click
  let _lastValidationResult = null;
  let _isValidating = false;
  let _projectAvailability = null;  // Map<dateKey, dayRecord> from window-availability
  let _availabilityMeta = null;     // { totalActiveTechnicians, dailyHours, horizonStart, horizonEnd }
  let _windowResult = null;         // last preferred-window verdict for the selected range
  let _windowError = null;          // transport/API failure message (distinct from "insufficient")
  let _availabilityError = null;
  let _availabilityExtendPromise = null;
  let _availabilityRequestId = 0;
  let _endDatePromptShown = false;
  let _minProjectStartKey = null;
  let _projectPreferences = {
    workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    preferredWorkingHours: 'morning',
  };

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const DAYS_LONG = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const WORKING_DAY_KEYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];

  function normalizeProjectPreferences(value) {
    const suppliedDays = Array.isArray(value?.workingDays)
      ? value.workingDays.filter(day => WORKING_DAY_KEYS.includes(day))
      : null;
    return {
      workingDays: suppliedDays || ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      preferredWorkingHours: value?.preferredWorkingHours === 'afternoon' ? 'afternoon' : 'morning',
    };
  }

  function formatDateKey(d) {
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  }

  function projectRequiredHours() {
    return Math.max(1, Math.round(_totalEstimatedMinutes / 6) / 10);
  }

  function earliestFeasibleProjectEndDate(startKey, dailyAvailability, requiredHours) {
    if (!startKey || typeof dailyAvailability?.entries !== 'function') return null;
    let availableHours = 0;
    for (const [date, day] of [...dailyAvailability.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (date < startKey) continue;
      availableHours += day?.isWorkingDay === false ? 0 : Math.max(0, Number(day?.capacityHours) || 0);
      if (date > startKey && day?.isWorkingDay !== false && Number(day?.capacityHours) > 0 &&
          availableHours + 1e-9 >= requiredHours) return date;
    }
    return null;
  }

  async function ensureProjectAvailabilityThrough(targetDate) {
    if (_mode !== 'project' || !_availabilityMeta || !_projectAvailability) return false;
    const targetKey = formatDateKey(targetDate);
    if (targetKey <= _availabilityMeta.horizonEnd) return true;
    if (_availabilityExtendPromise) {
      const loaded = await _availabilityExtendPromise;
      return loaded ? ensureProjectAvailabilityThrough(targetDate) : false;
    }
    const requestId = _availabilityRequestId;
    const nextDay = new Date(`${_availabilityMeta.horizonEnd}T00:00:00`);
    nextDay.setDate(nextDay.getDate() + 1);
    const extensionEnd = new Date(nextDay);
    extensionEnd.setDate(extensionEnd.getDate() + 74);
    const endKey = targetKey > formatDateKey(extensionEnd) ? targetKey : formatDateKey(extensionEnd);
    _availabilityError = null;
    _availabilityExtendPromise = (async () => {
      try {
        const response = await fetch('/api/projects/window-availability', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate: formatDateKey(nextDay), endDate: endKey }),
        });
        if (!response.ok) throw new Error('Could not load project dates');
        const data = await response.json();
        if (requestId !== _availabilityRequestId) return false;
        (data.days || []).forEach(day => _projectAvailability.set(day.date, day));
        _availabilityMeta.horizonEnd = endKey;
        _availabilityError = null;
        return true;
      } catch (error) {
        if (requestId === _availabilityRequestId) _availabilityError = 'Could not load more available dates. Try again.';
        return false;
      }
    })();
    render();
    const loaded = await _availabilityExtendPromise;
    if (requestId === _availabilityRequestId) {
      _availabilityExtendPromise = null;
      render();
    }
    return loaded;
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function minutesToTime(m) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    const period = h >= 12 ? 'PM' : 'AM';
    const display = h > 12 ? h - 12 : h === 0 ? 12 : h;
    return `${display}:${String(min).padStart(2,'0')} ${period}`;
  }

  function injectStyles() {
    if (document.getElementById('ent-calendar-styles')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/css/enterprise-calendar.css?v=20261001-project-date-guide-v1';
    link.id = 'ent-calendar-styles';
    document.head.appendChild(link);
  }

  function getElement(id) {
    if (_root && _root !== document && typeof _root.querySelector === 'function') {
      return _root.querySelector(`#${id}`);
    }
    return document.getElementById(id);
  }

  async function init(opts = {}) {
    _availabilityRequestId++;
    _timeSlotRequestId++;
    _availabilityExtendPromise = null;
    _availabilityError = null;
    _windowResult = null;
    _windowError = null;
    _lastValidationResult = null;
    _endDatePromptShown = false;
    _minProjectStartKey = opts.minProjectStartDate ? formatDateKey(opts.minProjectStartDate) : null;
    _projectAvailability = null;
    _availabilityMeta = null;
    _root = typeof opts.root === 'string'
      ? (document.querySelector(opts.root) || document)
      : (opts.root || document);
    _syncGlobalState = opts.syncGlobalState !== false;
    _serviceId = opts.serviceId;
    _technicianId = opts.technicianId || null;
    _duration = opts.duration || 90;
    _hasExplicitDuration = Number.isFinite(Number(opts.duration)) && Number(opts.duration) > 0;
    _travelTime = Math.max(0, Number(opts.travelTime) || 30);
    // Project classification is based on the total units in the complete
    // Core + Repair request, not only the last service card opened.
    _quantity = Math.min(40, Math.max(
      1,
      Number(opts.quantity) || 1,
      _syncGlobalState ? getCustomerUnitTotal() : 1,
    ));
    _onSelectCb = typeof opts.onSelect === 'function' ? opts.onSelect : null;
    _showCommercialProjects = opts.showCommercialProjects !== false;
    const restoredProjectPreferences = _syncGlobalState
      ? window.BookingState?.projectScheduling?.preferences
      : null;
    _projectPreferences = normalizeProjectPreferences(restoredProjectPreferences);
    if (opts.resetSelection === true) {
      _selectedDate = null;
      _selectedSlot = null;
      _selectedEndDate = null;
      _selectingEndDate = false;
    } else if (_syncGlobalState && window.BookingState) {
      const restoredDate = window.BookingState.selectedDate || window.BookingState.scheduleDate;
      const parsedDate = restoredDate ? new Date(restoredDate) : null;
      _selectedDate = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null;
      _selectedSlot = window.BookingState.selectedTimeSlot || null;

      const restoredEndDate = window.BookingState.projectScheduling?.endDate;
      const parsedEndDate = restoredEndDate ? new Date(restoredEndDate) : null;
      _selectedEndDate = parsedEndDate && !Number.isNaN(parsedEndDate.getTime()) ? parsedEndDate : null;
      _selectingEndDate = Boolean(_selectedDate && !_selectedEndDate);
    }
    if (typeof opts.nextStep === 'number') _nextStep = opts.nextStep;
    _currentMonth = _selectedDate ? new Date(_selectedDate) : new Date();
    _currentMonth.setDate(1);
    _currentMonth.setHours(0, 0, 0, 0);

    // Large-scale detection
    _totalEstimatedMinutes = Number(opts.totalEstimatedMinutes) || 0;
    _mode = opts.mode === 'preferred' ? 'preferred' : opts.mode === 'project' ? 'project' : 'appointment';
    _isLargeProject = false;
    if (_mode !== 'preferred' && _totalEstimatedMinutes > 0) {
      _isLargeProject = await detectLargeProject(_totalEstimatedMinutes);
    }
    if (_mode === 'project' || _isLargeProject) {
      _mode = 'project';
    }

    injectStyles();
    await loadData();
    if (_mode === 'project') {
      await ensureProjectAvailabilityThrough(new Date(_currentMonth.getFullYear(), _currentMonth.getMonth() + 1, 0));
    }
    render();
    if (_mode === 'appointment' && _selectedDate) await loadTimeSlots(_selectedDate);
  }

  /**
   * Client-side large-scale detection.
   * Uses a configurable threshold (default 8 working hours) aligned with the
   * company's daily working-hours capacity. A request exceeding one technician's
   * standard working day is treated as a multi-day project.
   */
  async function detectLargeProject(totalMinutes) {
    if (!totalMinutes || totalMinutes <= 0) return false;
    let thresholdHours = 8; // default working-hours threshold
    try {
      if (window.__bookingPolicy && window.__bookingPolicy.largeProjectThresholdHours) {
        thresholdHours = Number(window.__bookingPolicy.largeProjectThresholdHours) || 8;
      }
    } catch (e) { /* noop */ }
    return totalMinutes > thresholdHours * 60;
  }

  async function loadData() {
    try {
      const holPromise = fetch('/api/schedule/holidays-and-nonworking');
      const policyPromise = fetch('/api/schedule/booking-policy');
      const projPromise = fetch(`/api/schedule/projects?month=${_currentMonth.getFullYear()}-${String(_currentMonth.getMonth() + 1).padStart(2, '0')}`)
        .then(r => r.ok ? r.json() : { projects: [] })
        .catch(() => ({ projects: [] }));
      let schPromise;
      if (_mode !== 'preferred' && (_serviceId || _duration)) {
        const params = new URLSearchParams({ duration: _duration, mode: 'manual' });
        if (_serviceId) params.set('serviceId', _serviceId);
        if (_quantity > 1) params.set('quantity', _quantity);
        if (_travelTime > 0) params.set('travelTime', _travelTime);
        if (_technicianId) params.set('technicianId', _technicianId);
        schPromise = fetch(`/api/schedule/available-dates?${params.toString()}`);
      } else {
        schPromise = Promise.resolve({ ok: false });
      }
      const [schRes, holRes, policyRes, projRes] = await Promise.all([schPromise, holPromise, policyPromise, projPromise]);
      _scheduleData = schRes.ok ? await schRes.json() : { availableDates: [] };
      _holidaysData = holRes.ok ? await holRes.json() : { holidays: [], nonWorkingDays: [] };
      _projectsData = (projRes && Array.isArray(projRes.projects)) ? projRes.projects : [];

      // Load inspection duration from booking policy for repair services
      if (policyRes.ok) {
        const policyData = await policyRes.json();
        window.__bookingPolicy = policyData;
        if (!_serviceId && !_hasExplicitDuration && policyData.inspectionDurationMinutes) {
          _duration = policyData.inspectionDurationMinutes;
        }
        if (policyData.largeProjectThresholdHours) {
          // already applied lazily in detectLargeProject via window.__bookingPolicy
        }
      }

      // The configured threshold may differ from the fallback used before
      // this request. Apply it before loading project availability.
      if (_mode !== 'preferred' && _totalEstimatedMinutes > 0 && await detectLargeProject(_totalEstimatedMinutes)) {
        _isLargeProject = true;
        _mode = 'project';
      }

      // ── Load project-mode availability data ─────────────────────────────
      // Project mode uses the window-availability endpoint, which returns
      // REAL per-day technician counts (e.g. "1 of 2 technicians") and
      // capacity-hours per date. This is what powers the calendar states,
      // the availability summary, and the capacity verdict.
      _projectAvailability = null;
      _availabilityMeta = null;
      _projectCapacityData = null; // legacy fallback only
      _availabilityError = null;
      if (_mode === 'project' || _scheduleData.blocked) {
        const todayKey = formatDateKey(new Date());
        const horizon = new Date();
        horizon.setDate(horizon.getDate() + 75);
        try {
          const avRes = await fetch('/api/projects/window-availability', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ startDate: todayKey, endDate: formatDateKey(horizon) }),
          });
          if (avRes.ok) {
            const avData = await avRes.json();
            _projectAvailability = new Map((avData.days || []).map(d => [d.date, d]));
            _availabilityMeta = {
              totalActiveTechnicians: avData.totalActiveTechnicians || 0,
              dailyHours: avData.dailyHours || 8,
              horizonStart: todayKey,
              horizonEnd: formatDateKey(horizon),
            };
          } else {
            _availabilityError = 'Could not load available project dates. Try again.';
          }
        } catch (avErr) {
          calendarDebug('EnterpriseCalendar: window-availability load error', avErr);
          _availabilityError = 'Could not load available project dates. Try again.';
        }

        // Legacy fallback so a failed availability fetch cannot brick the UI.
        if (!_projectAvailability && _mode !== 'project') {
          try {
            const capParams = new URLSearchParams({
              duration: '60',
              quantity: '1',
              mode: 'manual',
            });
            if (_serviceId) capParams.set('serviceId', _serviceId);
            const capRes = await fetch(`/api/schedule/available-dates?${capParams.toString()}`);
            if (capRes.ok) {
              const capData = await capRes.json();
              _projectCapacityData = capData.availableDates || null;
            }
          } catch (capErr) {
            calendarDebug('EnterpriseCalendar: project capacity data load error', capErr);
            _projectCapacityData = null;
          }
        }
      }

      calendarDebug('EnterpriseCalendar: Data loaded', {
        availableDates: _scheduleData.availableDates?.length || 0,
        projectCapacityDates: _projectCapacityData?.length || 0,
        holidays: _holidaysData.holidays?.length || 0,
        nonWorkingDays: _holidaysData.nonWorkingDays?.length || 0,
        duration: _duration,
        mode: _mode,
        isLargeProject: _isLargeProject,
        blocked: !!_scheduleData.blocked,
      });
    } catch (e) {
      console.error('EnterpriseCalendar: load error', e);
      _scheduleData = { availableDates: [] };
      _holidaysData = { holidays: [], nonWorkingDays: [] };
      _projectCapacityData = null;
    }
  }

  async function refresh() {
    await loadData();
    render();
  }

  function render() {
    if (_mode === 'project') {
      renderProjectMode();
      return;
    }
    renderAppointmentMode();
  }

  /* ──────────────────────────────────────────────────────────────
   * APPOINTMENT MODE (standard date + time-slot selection)
   * ────────────────────────────────────────────────────────────── */
  function renderAppointmentMode() {
    const container = getElement('calendarGrid');
    if (!container) return;

    // Show blocked message if booking exceeds working hours
    if (_scheduleData?.blocked) {
      container.innerHTML = `
        <div class="ent-calendar">
          <div class="ent-cal-blocked" style="text-align:center;padding:2rem;color:#dc2626;">
            <i class="bi bi-exclamation-triangle-fill" style="font-size:2rem;"></i>
            <h5 style="margin-top:1rem;">Schedule not available</h5>
            <p style="color:#64748b;margin-top:0.5rem;">${escapeHtml(_scheduleData.message || 'This booking does not fit the available work hours. Reduce the number of units or contact us for a project schedule.')}</p>
          </div>
        </div>`;
      return;
    }

    const year = _currentMonth.getFullYear();
    const month = _currentMonth.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date(); today.setHours(0,0,0,0);

    const availMap = {};
    (_scheduleData?.availableDates || []).forEach(d => { availMap[d.date] = d; });

    const holMap = {};
    (_holidaysData?.holidays || []).forEach(h => {
      holMap[formatDateKey(new Date(h.date))] = { type: 'holiday', name: h.name || 'Holiday' };
    });
    (_holidaysData?.nonWorkingDays || []).forEach(n => {
      const key = formatDateKey(new Date(n.date));
      if (!holMap[key]) holMap[key] = { type: 'non-working', name: n.reason || 'Non-working day' };
    });

    // Active commercial-project reservations for this month (read-only overlay).
    // Maps dateKey -> total technicians reserved by projects that day.
    const projectReservedMap = {};
    const monthProjects = [];
    (_projectsData || []).forEach(p => {
      const reserved = p.reservedByDate || {};
      if (!reserved || !Object.keys(reserved).length) return;
      monthProjects.push(p);
      Object.keys(reserved).forEach(k => {
        projectReservedMap[k] = (projectReservedMap[k] || 0) + (reserved[k] || 0);
      });
    });

    let html = `<div class="ent-calendar">`;

    // Header
    html += `
      <div class="ent-cal-header">
        <button class="ent-cal-nav-btn" id="entCalPrev" aria-label="Previous month">
          <i class="bi bi-chevron-left"></i>
        </button>
        <h6 class="mb-0">${MONTHS[month]} ${year}</h6>
        <button class="ent-cal-nav-btn" id="entCalNext" aria-label="Next month">
          <i class="bi bi-chevron-right"></i>
        </button>
      </div>
      <div class="ent-cal-mode">
        <span class="mode-dot capacity"></span>
        <span>${_mode === 'preferred' ? 'Choose a preferred day. Staff will confirm availability after reviewing your request.' : 'Tap a green or orange date to see its available times.'}</span>
      </div>
      <div class="ent-cal-legend">
        ${_mode === 'preferred' ? '<div class="ent-cal-legend-item"><span class="ent-cal-legend-dot available"></span>Preferred date</div><div class="ent-cal-legend-item"><span class="ent-cal-legend-dot holiday"></span>Holiday / closed</div>' : `
        <div class="ent-cal-legend-item"><span class="ent-cal-legend-dot available"></span>Available</div>
        <div class="ent-cal-legend-item"><span class="ent-cal-legend-dot limited"></span>Few times left</div>
        <div class="ent-cal-legend-item"><span class="ent-cal-legend-dot full"></span>Fully booked</div>
        <div class="ent-cal-legend-item"><span class="ent-cal-legend-dot holiday"></span>Holiday</div>
        <div class="ent-cal-legend-item"><span class="ent-cal-legend-dot non-working"></span>No service</div>`}
      </div>
      <div class="ent-cal-days">
        ${DAYS_SHORT.map(d => `<div class="ent-cal-day-name">${d}</div>`).join('')}
      </div>
      <div class="ent-cal-grid">`;

    // Empty cells before first day
    for (let i = 0; i < firstDay; i++) {
      html += `<div class="ent-cal-cell empty"></div>`;
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dateObj = new Date(year, month, day);
      const key = formatDateKey(dateObj);
      const dateKey = key;
      const isPast = dateKey < formatDateKey(today);
      const isToday = dateKey === formatDateKey(today);
      const holInfo = holMap[dateKey];
      const availInfo = availMap[dateKey];

      // Determine cell state
      let cellClass = 'ent-cal-cell';
      let tooltipText = '';
      let reasonText = '';
      let clickable = false;

      if (_mode === 'preferred') {
        if (isPast) cellClass += ' past';
        else if (holInfo) {
          cellClass += holInfo.type === 'holiday' ? ' holiday' : ' non-working';
          reasonText = holInfo.name;
          tooltipText = `${holInfo.type === 'holiday' ? 'Holiday' : 'Closed'}: ${holInfo.name}`;
        } else {
          cellClass += ' available';
          clickable = true;
          tooltipText = 'Request this preferred date; availability is confirmed by staff';
        }
      } else if (isPast) {
        cellClass += ' past';
      } else if (isToday) {
        // TODAY takes precedence over everything else.
        if (holInfo && holInfo.type === 'holiday') {
          cellClass += ' holiday';
          reasonText = holInfo.name;
          tooltipText = `Holiday: ${holInfo.name}`;
        } else if (availInfo && availInfo.availableSlots > 0) {
          const now = new Date();
          const currentMinutes = now.getHours() * 60 + now.getMinutes();
          const minAdvance = (window.__bookingPolicy && window.__bookingPolicy.minAdvanceNoticeMinutes) || 120;
          const earliestMinutes = now.getMinutes() + minAdvance >= 60
            ? (now.getHours() + Math.floor((now.getMinutes() + minAdvance) / 60)) * 60 + ((now.getMinutes() + minAdvance) % 60)
            : currentMinutes + minAdvance;
          const endOfDay = (typeof COMPANY_END_MINUTES !== 'undefined' && COMPANY_END_MINUTES) || 1020;
          if (earliestMinutes >= endOfDay) {
            cellClass += ' non-working';
            reasonText = 'Closed Today';
            tooltipText = 'Booking window for today has passed';
          } else {
            cellClass += ' limited';
            clickable = true;
            const count = availInfo.availableSlots;
            tooltipText = `${count} start time${count !== 1 ? 's' : ''} available today`;
          }
        } else if (availInfo && availInfo.availableSlots === 0) {
          cellClass += ' non-working';
          reasonText = 'Fully booked';
          tooltipText = 'No start times available today';
        } else if (holInfo) {
          cellClass += ' non-working';
          reasonText = 'Closed Today';
          tooltipText = 'No remaining slots for today';
        } else {
          cellClass += ' non-working';
          reasonText = 'Closed Today';
          tooltipText = 'Not accepting bookings for today';
        }
      } else if (availInfo) {
        // Capacity-based availability always takes priority over holMap
        if (availInfo.availableSlots === 0) {
          cellClass += ' full';
          reasonText = 'Fully Booked';
          tooltipText = 'No start times available on this date';
        } else if (availInfo.availableSlots <= 3) {
          cellClass += ' limited';
          clickable = true;
          const count = availInfo.availableSlots;
          tooltipText = `${count} start time${count !== 1 ? 's' : ''} available`;
        } else {
          cellClass += ' available';
          clickable = true;
          const count = availInfo.availableSlots;
          tooltipText = `${count} start times available`;
        }
      } else if (holInfo) {
        if (holInfo.type === 'holiday') {
          cellClass += ' holiday';
          reasonText = holInfo.name;
          tooltipText = `Holiday: ${holInfo.name}`;
        } else {
          cellClass += ' non-working';
          reasonText = 'Non-Working Day';
          tooltipText = `Non-Working: ${holInfo.name}`;
        }
      } else {
        // Not in schedule data and not a holiday — Non-Working Day (weekend / off-day)
        cellClass += ' non-working';
        reasonText = 'Non-Working Day';
        tooltipText = 'Not a working day';
      }

      // Commercial-project reservation marker (read-only overlay).
      const projReserved = projectReservedMap[key];
      if (projReserved && !isPast) {
        cellClass += ' project-reserved';
        if (!reasonText) reasonText = `Project: ${projReserved} tech${projReserved !== 1 ? 's' : ''} reserved`;
        else reasonText += ` · ${projReserved} tech${projReserved !== 1 ? 's' : ''} reserved`;
        tooltipText = (tooltipText ? tooltipText + ' · ' : '') + `${projReserved} technician(s) reserved by commercial project(s)`;
      }


      if (_selectedDate && key === formatDateKey(_selectedDate)) {
        cellClass += ' selected';
      }
      if (isToday) {
        cellClass += ' today';
      }

      const spokenDate = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      const spokenStatus = clickable ? tooltipText : (reasonText || (isPast ? 'Past date' : 'Unavailable'));
      html += `<div class="${cellClass}" data-date="${key}" aria-label="${escapeHtml(`${spokenDate}, ${spokenStatus}`)}" ${clickable ? `role="button" tabindex="0" aria-pressed="${Boolean(_selectedDate && key === formatDateKey(_selectedDate))}"` : ''}>`;
      if (tooltipText) {
        html += `<span class="ent-cal-tooltip">${escapeHtml(tooltipText)}</span>`;
      }
      html += `<span class="ent-cal-date">${day}</span>`;
      if (reasonText) {
        html += `<span class="ent-cal-reason">${escapeHtml(reasonText)}</span>`;
      }
      html += `</div>`;
    }

    html += `</div>`; // end grid

    // ── Commercial project bars (read-only) ──────────────────────────────
    if (_showCommercialProjects && monthProjects.length > 0) {
      html += `<div class="ent-project-strip">`;
      html += `<div class="ent-project-strip-title"><i class="bi bi-kanban"></i>Commercial Projects (${monthProjects.length}) — remaining capacity shown above</div>`;
      monthProjects.forEach(p => {
        const startDate = new Date(p.start);
        const endDate = new Date(p.end);
        const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const spanTxt = `${fmt(startDate)} – ${fmt(endDate)}`;
        const scale = p.isLargeScale ? 'ent-proj-large' : 'ent-proj-std';
        const statusLabel = {
          pending_project_scheduling: 'Pending Scheduling',
          accepted: 'Accepted',
          planning: 'Planning',
          in_progress: 'In Progress',
          on_hold: 'On Hold',
        }[p.status] || p.status;
        html += `
          <div class="ent-proj-bar ${scale}">
            <div class="ent-proj-bar-head">
              <span class="ent-proj-name">${escapeHtml(p.name)}</span>
              <span class="ent-proj-meta">${p.reservedTechnicians} tech${p.reservedTechnicians !== 1 ? 's' : ''} reserved</span>
            </div>
            <div class="ent-proj-bar-sub">
              <span>${spanTxt}</span>
              <span class="ent-proj-status">${statusLabel}</span>
            </div>
          </div>`;
      });
      html += `</div>`;
    }

    html += `</div>`; // end calendar

    container.innerHTML = html;

    // Bind nav
    getElement('entCalPrev')?.addEventListener('click', () => {
      const prevMonth = new Date(_currentMonth);
      prevMonth.setMonth(prevMonth.getMonth() - 1);
      _currentMonth = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), 1);
      render();
    });
    getElement('entCalNext')?.addEventListener('click', () => {
      const nextMonth = new Date(_currentMonth);
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      _currentMonth = new Date(nextMonth.getFullYear(), nextMonth.getMonth(), 1);
      render();
    });

    // Bind day clicks
    container.querySelectorAll('.ent-cal-cell.available, .ent-cal-cell.limited').forEach(cell => {
      cell.addEventListener('click', () => handleDateSelect(cell.dataset.date));
      cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleDateSelect(cell.dataset.date); }
      });
    });
  }

  async function handleDateSelect(dateStr) {
    // Block past dates
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const selectedDate = new Date(dateStr + 'T00:00:00');
    if (selectedDate < today) return;

    const parts = dateStr.split('-');
    _selectedDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), _mode === 'preferred' ? 12 : 0);
    _selectedSlot = null;
    if (_syncGlobalState && window.BookingState) {
      window.BookingState.selectedDate = _selectedDate;
      window.BookingState.scheduleDate = _selectedDate;
      window.BookingState.selectedTimeSlot = null;
      window.BookingState.selectedTime = null;
      window.BookingState.scheduleTime = null;
      if (typeof window.saveBookingProgress === 'function') window.saveBookingProgress();
    }
    render();
    if (_syncGlobalState) window.syncScheduleNextAction?.();
    if (_mode !== 'preferred') await loadTimeSlots(_selectedDate);
  }

  async function loadTimeSlots(date) {
    const section = getElement('timeSelection');
    const container = getElement('timeSlots');
    if (!section || !container) return;
    const requestId = ++_timeSlotRequestId;

    section.classList.remove('d-none');

    // Auto-scroll to time slots so customer notices them
    setTimeout(() => {
      section.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);

    // Build the enterprise time-slot section shell
    const dateLabel = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    container.innerHTML = `
      <div class="ent-cal-guidance-banner">
        <i class="bi bi-calendar-check" aria-hidden="true"></i>
        <span><strong>${dateLabel}</strong> selected. Now pick a start time.</span>
      </div>
      <div class="ent-time-section ent-time-section-pulse">
        <div class="ent-time-header">
          <div><h6><i class="bi bi-clock" aria-hidden="true"></i>Choose a start time</h6><p>These are the times you can request for your service.</p></div>
          <span class="ent-time-date">${dateLabel}</span>
        </div>
        <div class="ent-time-grid" id="entTimeGrid" aria-live="polite">
          <div class="ent-cal-loading"><div class="spinner-border" role="status"></div><span>Checking available times...</span></div>
        </div>
      </div>`;

    const grid = getElement('entTimeGrid');

    try {
      // Try API-based time slots first
      const apiResult = await fetchTimeSlotsFromAPI(date);
      if (requestId !== _timeSlotRequestId) return;
      if (apiResult && apiResult.blocked) {
        grid.innerHTML = `
          <div class="ent-no-slots" style="text-align:center;padding:1.5rem;color:#dc2626;">
            <i class="bi bi-exclamation-triangle-fill" style="font-size:1.5rem;"></i>
            <p style="margin-top:0.5rem;">${escapeHtml(apiResult.message || 'Booking exceeds available working hours. Please reduce quantity.')}</p>
          </div>`;
        return;
      }
      if (apiResult && Array.isArray(apiResult.slots)) {
        renderTimeSlotsUI(grid, apiResult.slots);
        return;
      }
      grid.innerHTML = '<div class="ent-no-slots"><i class="bi bi-wifi-off" aria-hidden="true"></i><strong>We could not check available times.</strong><span>Please check your connection and try again.</span><button type="button" class="ent-time-retry">Try again</button></div>';
      grid.querySelector('.ent-time-retry')?.addEventListener('click', () => loadTimeSlots(date));
    } catch (e) {
      if (requestId !== _timeSlotRequestId) return;
      console.error('EnterpriseCalendar: time slot error', e);
      grid.innerHTML = '<div class="ent-no-slots"><i class="bi bi-exclamation-triangle" aria-hidden="true"></i><strong>We could not check available times.</strong><button type="button" class="ent-time-retry">Try again</button></div>';
      grid.querySelector('.ent-time-retry')?.addEventListener('click', () => loadTimeSlots(date));
    }
  }

  async function fetchTimeSlotsFromAPI(date) {
    if (!_serviceId && !_duration) return null;
    try {
      const params = new URLSearchParams({ date: formatDateKey(date) });
      if (_serviceId) params.set('serviceId', _serviceId);
      if (_duration) params.set('duration', _duration);
      if (_quantity > 1) params.set('quantity', _quantity);
      if (_travelTime > 0) params.set('travelTime', _travelTime);
      if (_technicianId) params.set('technicianId', _technicianId);
      const resp = await fetch(`/api/schedule/time-slots?${params.toString()}`, { cache: 'no-store' });
      if (!resp.ok) return null;
      const data = await resp.json();

      // Check if booking is blocked (exceeds working hours)
      if (data.blocked) {
        return { blocked: true, message: data.message, slots: [] };
      }

      if (!data.timeSlots || data.timeSlots.length === 0) return { slots: [] };

      const slots = data.timeSlots.map(slot => {
        const isPast = slot.isPast || false;
        const availableCount = slot.availableCount || 0;
        const available = slot.available === true && !isPast;
        return {
          startTime: slot.startTime,
          label: slot.startTime,
          available,
          availableCount,
          isPast,
          booked: !available && !isPast
        };
      });
      return { slots };
    } catch {
      return null;
    }
  }

  async function validateSelectedSlot() {
    if (_mode === 'project') return true;
    if (!_selectedDate || !_selectedSlot) return false;
    const selectedMinutes = timeToMinutes(_selectedSlot.startTime || _selectedSlot.label);
    const result = await fetchTimeSlotsFromAPI(_selectedDate);
    const stillAvailable = Number.isFinite(selectedMinutes)
      && Array.isArray(result?.slots)
      && result.slots.some(slot => slot.available === true && !slot.isPast
        && timeToMinutes(slot.startTime) === selectedMinutes);
    if (stillAvailable) return true;

    _selectedSlot = null;
    if (_syncGlobalState && window.BookingState) {
      window.BookingState.selectedTimeSlot = null;
      window.BookingState.selectedTime = null;
      window.BookingState.scheduleTime = null;
      if (typeof window.saveBookingProgress === 'function') window.saveBookingProgress();
    }
    if (_syncGlobalState && window.RepairState) window.RepairState.preferredTime = '';
    if (_syncGlobalState) window.syncScheduleNextAction?.();
    await loadTimeSlots(_selectedDate);
    return false;
  }

  function timeToMinutes(t) {
    const match = String(t || '').trim().match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
    if (!match) return NaN;
    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    const period = String(match[3] || '').toUpperCase();
    if (period) {
      hours %= 12;
      if (period === 'PM') hours += 12;
    }
    return hours * 60 + minutes;
  }

  function renderTimeSlotsUI(container, slots) {
    if (!Array.isArray(slots) || slots.length === 0) {
      container.innerHTML = '<div class="ent-no-slots"><i class="bi bi-calendar-x" aria-hidden="true"></i><strong>No times are available on this date.</strong><span>Choose another highlighted date on the calendar.</span></div>';
      return;
    }
    const availableTimes = slots.filter(slot => slot.available && !slot.isPast).length;
    let html = `<p class="ent-time-count">${availableTimes} start time${availableTimes === 1 ? '' : 's'} available · ${availableTimes ? 'Tap a time to continue' : 'Choose another date'}</p>`;
    slots.forEach((slot, idx) => {
      const isUnavailable = !slot.available && !slot.isPast;
      const isSelected = Boolean(slot.available && !slot.isPast && _selectedSlot?.startTime === slot.startTime);
      let cls = 'ent-time-slot';
      if (slot.isPast) cls += ' past';
      else if (isUnavailable) cls += ' unavailable';
      if (isSelected) cls += ' selected';

      let statusCls = 'ent-time-slot-status';
      let statusLabel = '';

      if (slot.isPast) {
        statusCls += ' past';
        statusLabel = 'Time passed';
      } else if (isUnavailable) {
        statusCls += ' booked';
        statusLabel = 'Fully booked';
      } else {
        statusCls += ' available';
        statusLabel = isSelected ? 'Selected' : 'Available';
      }

      const slotLabel = escapeHtml(slot.label);
      html += `<div class="${cls}" data-idx="${idx}" data-start="${escapeHtml(slot.startTime)}" data-label="${slotLabel}" ${slot.available ? `role="button" tabindex="0" aria-pressed="${isSelected}" aria-label="${slotLabel}, ${statusLabel}"` : ''}>
        <div class="ent-time-slot-label">${slotLabel}</div>
        <span class="${statusCls}">${statusLabel}</span>
      </div>`;
    });

    container.innerHTML = html;

    // Bind clicks
    container.querySelectorAll('.ent-time-slot[role="button"]').forEach(el => {
      const chooseSlot = () => {
        _selectedSlot = {
          startTime: el.dataset.start,
          label: el.dataset.label,
          startMinutes: timeToMinutes(el.dataset.start),
        };
        // Sync with BookingState (if present)
        if (_syncGlobalState && window.BookingState) {
          window.BookingState.selectedTimeSlot = _selectedSlot;
          window.BookingState.selectedTime = _selectedSlot.label;
          window.BookingState.scheduleTime = _selectedSlot.label;
          window.BookingState.selectedDate = _selectedDate;
          window.BookingState.scheduleDate = _selectedDate;
          if (typeof window.saveBookingProgress === 'function') window.saveBookingProgress();
        }
        // Sync with RepairState (if present)
        if (_syncGlobalState && window.RepairState) {
          window.RepairState.preferredDate = _selectedDate;
          window.RepairState.preferredTime = _selectedSlot.label;
        }
        if (_syncGlobalState) window.syncScheduleNextAction?.();
        render();
        renderTimeSlotsUI(container, slots);
        // Fire onSelect callback if registered, otherwise auto-advance
        setTimeout(() => {
          if (_onSelectCb) {
            _onSelectCb({ date: _selectedDate, slot: _selectedSlot });
          } else if (typeof showStep === 'function') {
            showStep(_nextStep);
            if (typeof updateStepper === 'function') updateStepper(_nextStep);
          }
        }, 400);
      };
      el.addEventListener('click', chooseSlot);
      el.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseSlot(); }
      });
    });
  }

/* ──────────────────────────────────────────────────────────────
 * PROJECT MODE (large-scale / multi-day work)
 * Two-step range selection: pick start date → pick end date.
 * The customer may optionally provide scheduling preferences.
 *
 * When both dates are chosen, the ENTIRE date range is validated
 * against technician capacity. If insufficient capacity, a clear
 * message is shown and the next available date range is suggested.
 * ────────────────────────────────────────────────────────────── */
  function renderProjectMode() {
    const container = getElement('calendarGrid');
    if (!container) return;

    const year = _currentMonth.getFullYear();
    const month = _currentMonth.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date(); today.setHours(0,0,0,0);

    const holMap = {};
    (_holidaysData?.holidays || []).forEach(h => {
      holMap[formatDateKey(new Date(h.date))] = { type: 'holiday', name: h.name || 'Holiday' };
    });
    (_holidaysData?.nonWorkingDays || []).forEach(n => {
      const key = formatDateKey(new Date(n.date));
      if (!holMap[key]) holMap[key] = { type: 'non-working', name: n.reason || 'Non-working day' };
    });

    // ── Build capacity map from project-capacity data ──────────────────
    // Shows how many technician slots are available per date, so customers
    // can visually pick dates with sufficient capacity for their project.
    const capacityMap = {};
    const capSource = _projectCapacityData || _scheduleData?.availableDates || [];
    capSource.forEach(d => {
      capacityMap[d.date] = d.availableSlots;
    });

    // Also incorporate project reservations: days with many reserved techs
    // appear with reduced visible capacity.
    const projReservedMap = {};
    (_projectsData || []).forEach(p => {
      const reserved = p.reservedByDate || {};
      Object.keys(reserved).forEach(k => {
        projReservedMap[k] = (projReservedMap[k] || 0) + (reserved[k] || 0);
      });
    });

    let html = `<div class="ent-calendar ent-calendar-project">`;

    // Banner
    const totalHours = Math.round((_totalEstimatedMinutes / 60) * 10) / 10;
    const techCount = _availabilityMeta?.totalActiveTechnicians || null;
    const bannerTechNote = techCount ? ` Our team currently has <strong>${techCount} technician${techCount !== 1 ? 's' : ''}</strong> available.` : '';
    const bannerSub = `Choose when work can start, then choose the latest date you want it finished. Dates that cannot fit the work are unavailable. The team will confirm the final schedule. Estimated work: ${totalHours} hours.${bannerTechNote}`;
    html += `
      <div class="ent-project-banner">
        <i class="bi bi-kanban"></i>
        <div>
          <div class="ent-project-banner-title">Project Scheduling</div>
          <div class="ent-project-banner-sub">${bannerSub}</div>
        </div>
      </div>`;

    // Step indicators
    const startSelected = !!_selectedDate;
    const endSelected = !!_selectedEndDate;
    const earliestEndKey = startSelected
      ? earliestFeasibleProjectEndDate(formatDateKey(_selectedDate), _projectAvailability, projectRequiredHours())
      : null;
    const step1Class = startSelected ? 'completed' : 'active';
    const step2Class = endSelected ? 'completed' : (startSelected ? 'active' : 'pending');
    html += `
      <div class="ent-range-steps" aria-live="polite">
        <div class="ent-range-step ${step1Class}">
          <span class="ent-range-step-num">${startSelected ? '<i class="bi bi-check-lg"></i>' : '1'}</span>
          <span class="ent-range-step-label">Start Date${_selectedDate ? ': ' + formatDateDisplay(_selectedDate) : ''}</span>
        </div>
        <div class="ent-range-step-arrow"><i class="bi bi-arrow-right"></i></div>
        <div class="ent-range-step ${step2Class}">
          <span class="ent-range-step-num">${endSelected ? '<i class="bi bi-check-lg"></i>' : '2'}</span>
          <span class="ent-range-step-label">Finish By${_selectedEndDate ? ': ' + formatDateDisplay(_selectedEndDate) : (startSelected ? ' — select below' : '')}</span>
        </div>
        ${startSelected ? '<button type="button" class="ent-range-reset" id="projectRangeResetBtn"><i class="bi bi-arrow-counterclockwise"></i> Change dates</button>' : ''}
      </div>`;

    // Prompt text
    if (!startSelected) {
      html += `<div class="ent-range-prompt" role="status"><i class="bi bi-hand-index-thumb me-1"></i>First, choose the date the work can <strong>start</strong>.</div>`;
    } else if (!_selectedEndDate) {
      const endGuidance = earliestEndKey
        ? `The earliest available finish date is <strong>${formatDateDisplay(earliestEndKey)}</strong>. Choose that date or a later available date.`
        : _availabilityExtendPromise ? 'Checking which finish dates have enough time for the work...'
          : 'No finish date is available in the loaded calendar. Try another start date or view a later month.';
      html += `<div class="ent-range-prompt" role="status"><i class="bi bi-calendar-check me-1"></i>Now choose the <strong>latest date you want the service finished</strong>. ${endGuidance}</div>`;
    }
    if (_availabilityError || !_projectAvailability) {
      html += `<div class="ent-range-prompt ent-range-prompt-error" role="alert">${escapeHtml(_availabilityError || 'Available project dates could not be loaded.')} <button type="button" id="projectAvailabilityRetryBtn">Try again</button></div>`;
    }

    // Calendar header
    html += `
      <div class="ent-cal-header">
        <button class="ent-cal-nav-btn" id="entCalPrev" aria-label="Previous month">
          <i class="bi bi-chevron-left"></i>
        </button>
        <h6 class="mb-0">${MONTHS[month]} ${year}</h6>
        <button class="ent-cal-nav-btn" id="entCalNext" aria-label="Next month">
          <i class="bi bi-chevron-right"></i>
        </button>
      </div>
      <div class="ent-cal-legend">
        <div class="ent-cal-legend-item"><span class="ent-cal-legend-dot available"></span>Available</div>
        <div class="ent-cal-legend-item"><span class="ent-cal-legend-dot limited"></span>Limited Capacity</div>
        ${startSelected && !endSelected ? '<div class="ent-cal-legend-item"><span class="ent-cal-legend-dot too-soon"></span>Too soon to finish</div>' : ''}
        <div class="ent-cal-legend-item"><span class="ent-cal-legend-dot full"></span>No Project Capacity</div>
        <div class="ent-cal-legend-item"><span class="ent-cal-legend-dot selected"></span>Selected</div>
        <div class="ent-cal-legend-item"><span class="ent-cal-legend-dot in-range"></span>In Preferred Window</div>
        <div class="ent-cal-legend-item"><span class="ent-cal-legend-dot holiday"></span>Holiday</div>
        <div class="ent-cal-legend-item"><span class="ent-cal-legend-dot non-working"></span>Non-Working</div>
      </div>
      <div class="ent-cal-days">
        ${DAYS_SHORT.map(d => `<div class="ent-cal-day-name">${d}</div>`).join('')}
      </div>
      <div class="ent-cal-grid">`;

    for (let i = 0; i < firstDay; i++) {
      html += `<div class="ent-cal-cell empty"></div>`;
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dateObj = new Date(year, month, day);
      const key = formatDateKey(dateObj);
      const isPast = key < (_minProjectStartKey || formatDateKey(today));
      const isToday = key === formatDateKey(today);
      const holInfo = holMap[key];
      const availSlots = capacityMap[key];
      const availInfo = _projectAvailability ? (_projectAvailability.get(key) || null) : null;
      const projReserved = projReservedMap[key] || 0;

      let cellClass = 'ent-cal-cell';
      let reasonText = '';
      let slotsText = '';
      let tooltipText = '';
      let clickable = false;

      if (isPast) {
        cellClass += ' past';
        tooltipText = 'Past date';
      } else if (holInfo) {
        if (holInfo.type === 'holiday') {
          cellClass += ' holiday';
          reasonText = holInfo.name;
          tooltipText = `Holiday: ${holInfo.name}`;
        } else {
          cellClass += ' non-working';
          reasonText = 'Non-Working Day';
          tooltipText = `Non-Working: ${holInfo.name}`;
        }
      } else if (availInfo) {
        // Real availability data from the window-availability endpoint.
        // Labels always distinguish actual TECHNICIANS from work CAPACITY —
        // a slot count must never be shown as a technician count.
        const T = availInfo.totalTechnicians ?? (_availabilityMeta?.totalActiveTechnicians || 0);
        const A = availInfo.availableTechnicians ?? 0;
        const hrs = Math.round((availInfo.capacityHours || 0) * 10) / 10;
        if (!availInfo.isWorkingDay || availInfo.status === 'none') {
          cellClass += ' full';
          reasonText = 'No Project Capacity';
          tooltipText = 'No project capacity available on this date';
        } else if (availInfo.status === 'partial') {
          cellClass += ' limited';
          clickable = true;
          slotsText = `${A} of ${T} technicians`;
          reasonText = 'Limited Capacity';
          tooltipText = `Limited capacity: ${A} of ${T} technicians available (~${hrs}h project capacity)${projReserved > 0 ? ` · ${projReserved} reserved by projects` : ''}`;
        } else {
          cellClass += ' available';
          clickable = true;
          slotsText = `${A} technicians`;
          reasonText = 'Fully Available';
          tooltipText = `${A} technicians available · full daily capacity (~${hrs}h)`;
        }
      } else if (!_projectAvailability) {
        cellClass += ' unchecked';
        reasonText = 'Unavailable';
        tooltipText = 'Project availability could not be checked';
      } else if (availSlots !== undefined && _mode !== 'project') {
        // Legacy fallback: slot counts from /api/schedule/available-dates.
        // These are WORK SLOTS, never technicians.
        if (availSlots <= 0) {
          cellClass += ' full';
          reasonText = 'No Project Capacity';
          tooltipText = 'No available capacity on this date';
        } else if (availSlots <= 3) {
          cellClass += ' limited';
          clickable = true;
          slotsText = `${availSlots} work slot${availSlots !== 1 ? 's' : ''}`;
          reasonText = 'Limited Capacity';
          tooltipText = `Limited capacity: only ${availSlots} work slot${availSlots !== 1 ? 's' : ''} available${projReserved > 0 ? ` (${projReserved} reserved by projects)` : ''}`;
        } else {
          cellClass += ' available';
          clickable = true;
          slotsText = `${availSlots} work slots`;
          reasonText = 'Fully Available';
          tooltipText = `${availSlots} work slots available${projReserved > 0 ? ` (${projReserved} reserved by projects)` : ''}`;
        }
      } else if (_projectAvailability && _availabilityMeta && key >= _availabilityMeta.horizonStart && key <= _availabilityMeta.horizonEnd) {
        // Inside the loaded availability horizon but no record — the company
        // does not operate on this date. Never offer it for selection; the
        // backend validator treats it the same way.
        cellClass += ' non-working';
        reasonText = 'Non-Working Day';
        tooltipText = 'Not a working day';
      } else {
        // Dates outside the checked horizon stay unavailable until loaded.
        cellClass += ' unchecked';
        reasonText = _availabilityExtendPromise ? 'Checking...' : 'Not checked';
        tooltipText = 'Project availability is being checked';
      }

      if (clickable && startSelected && _selectingEndDate) {
        if (key <= formatDateKey(_selectedDate)) {
          clickable = false;
          if (key < formatDateKey(_selectedDate)) {
            cellClass += ' too-soon';
            reasonText = 'Before start';
            slotsText = '';
          }
          tooltipText = 'Choose a finish date after the start date';
        } else if (!earliestEndKey || key < earliestEndKey) {
          clickable = false;
          cellClass += ' too-soon';
          reasonText = earliestEndKey ? 'Too soon' : 'Not enough time';
          slotsText = '';
          tooltipText = earliestEndKey
            ? `The work cannot fit by this date. Earliest available finish: ${formatDateDisplay(earliestEndKey)}`
            : 'The work cannot fit by this date';
        }
      }

      // Range highlighting
      if (_selectedDate && key === formatDateKey(_selectedDate)) {
        cellClass += ' selected range-start';
      }
      if (_selectedEndDate && key === formatDateKey(_selectedEndDate)) {
        cellClass += ' selected range-end';
      }
      if (_selectedDate && _selectedEndDate) {
        const startKey = formatDateKey(_selectedDate);
        const endKey = formatDateKey(_selectedEndDate);
        // The ENTIRE preferred window stays highlighted — availability state
        // is shown on top of the highlight, never replaces it.
        if (key > startKey && key < endKey && !isPast) {
          cellClass += ' in-range';
        }
      }

      // Project reservation overlay
      if (projReserved > 0 && !isPast && !holInfo) {
        cellClass += ' project-reserved';
      }

      if (isToday) cellClass += ' today';

      const dateAriaLabel = escapeHtml(`${formatDateDisplay(dateObj)}. ${tooltipText || 'Select date'}`);
      html += `<div class="${cellClass}" data-date="${key}" ${clickable ? `role="button" tabindex="0" aria-label="${dateAriaLabel}"` : ''}>`;
      if (tooltipText) html += `<span class="ent-cal-tooltip">${tooltipText}</span>`;
      html += `<span class="ent-cal-date">${day}</span>`;
      if (slotsText) html += `<span class="ent-cal-slots">${slotsText}</span>`;
      if (reasonText) html += `<span class="ent-cal-reason">${reasonText}</span>`;
      html += `</div>`;
    }

    html += `</div>`;

    // ── Preferred Window Capacity Verdict ─────────────────────────────────
    if (_selectedDate && _selectedEndDate && !_selectingEndDate) {
      if (_isValidating) {
        html += `
          <div class="ent-range-validation ent-range-validating">
            <div class="spinner-border spinner-border-sm me-2" role="status"></div>
            <span>Checking available work capacity inside your preferred window...</span>
          </div>`;
      } else if (_windowError) {
        html += `
          <div class="ent-range-validation ent-range-invalid" id="projectRangeValidation">
            <i class="bi bi-wifi-off me-2"></i>
            <span>${_windowError}</span>
          </div>`;
      } else if (_windowResult) {
        const wr = _windowResult;
        const t = wr.totals || {};
        const techLine = `${wr.totalActiveTechnicians || 0} technician${(wr.totalActiveTechnicians || 0) !== 1 ? 's' : ''} on the team · ${wr.dailyHours || 8}h/day each`;
        if (wr.sufficient) {
          const estDone = wr.estimatedCompletionDate
            ? ` Project can be completed by <strong>${formatDateDisplay(wr.estimatedCompletionDate)}</strong>${formatDateKey(new Date(wr.estimatedCompletionDate)) < formatDateKey(_selectedEndDate) ? ' — earlier than your preferred end date' : ''}.`
            : '';
          html += `
            <div class="ent-range-validation ent-range-valid" id="projectRangeValidation">
              <div style="flex:1;">
                <div class="d-flex align-items-center gap-2">
                  <i class="bi bi-check-circle-fill"></i>
                  <span>This preferred date window can accommodate the project.</span>
                </div>
                <div class="small mt-1">${techLine}</div>
                <div class="small">Available capacity in window: <strong>${t.totalAvailableHours ?? 0} technician-hours</strong> across ${t.workableDays ?? 0} workable day(s)</div>
                <div class="small">Required project capacity: <strong>${wr.requiredHours} technician-hours</strong></div>${estDone}
                <div class="small text-muted mt-1">Note: The final work schedule will be generated based on technician availability and confirmed project planning.</div>
              </div>
            </div>`;
        } else {
          const earliest = wr.earliestCompletionDate
            ? `<p class="mb-1 small">Earliest estimated completion based on current availability: <strong>${formatDateDisplay(wr.earliestCompletionDate)}</strong></p>`
            : '<p class="mb-1 small">No feasible completion date was found within the next 180 days at current staffing levels.</p>';
          html += `
            <div class="ent-range-validation ent-range-invalid" id="projectRangeValidation">
              <div class="d-flex align-items-start gap-2" style="flex:1;">
                <i class="bi bi-exclamation-triangle-fill" style="font-size:1.2rem;margin-top:0.15rem;flex-shrink:0;"></i>
                <div style="flex:1;">
                  <strong>The selected date range does not provide enough available working capacity for this project.</strong>
                  <p class="mb-1 mt-1 small">This window provides approximately <strong>${t.workableDays ?? 0} workable day(s)</strong> (${t.totalAvailableHours ?? 0} technician-hours), but this project is estimated to require at least <strong>${wr.minimumRequiredDays} working day(s)</strong> (${wr.requiredHours} technician-hours).</p>
                  ${earliest}
                  <div class="d-flex gap-2 mt-2 flex-wrap">
                    <button type="button" class="btn btn-sm btn-outline-primary" id="adjustEndDateBtn"><i class="bi bi-calendar-range me-1"></i>Adjust End Date</button>
                    ${wr.earliestCompletionDate ? `<button type="button" class="btn btn-sm btn-primary" id="useRecommendedBtn"><i class="bi bi-check2 me-1"></i>Use Recommended Date</button>` : ''}
                  </div>
                </div>
              </div>
            </div>`;
        }
      }
    }

    html += `</div>`;
    container.innerHTML = html;

    // Nav
    getElement('entCalPrev')?.addEventListener('click', () => {
      const prevMonth = new Date(_currentMonth);
      prevMonth.setMonth(prevMonth.getMonth() - 1);
      _currentMonth = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), 1);
      render();
      ensureProjectAvailabilityThrough(new Date(_currentMonth.getFullYear(), _currentMonth.getMonth() + 1, 0));
    });
    getElement('entCalNext')?.addEventListener('click', () => {
      const nextMonth = new Date(_currentMonth);
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      _currentMonth = new Date(nextMonth.getFullYear(), nextMonth.getMonth(), 1);
      render();
      ensureProjectAvailabilityThrough(new Date(_currentMonth.getFullYear(), _currentMonth.getMonth() + 1, 0));
    });
    getElement('projectRangeResetBtn')?.addEventListener('click', () => {
      resetRange();
      getElement('calendarGrid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // Day clicks → range selection (both available and limited-capacity days)
    container.querySelectorAll('.ent-cal-cell[role="button"]').forEach(cell => {
      cell.addEventListener('click', () => handleProjectDateSelect(cell.dataset.date));
      cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleProjectDateSelect(cell.dataset.date); }
      });
    });

    getElement('projectAvailabilityRetryBtn')?.addEventListener('click', async () => {
      await loadData();
      await ensureProjectAvailabilityThrough(new Date(_currentMonth.getFullYear(), _currentMonth.getMonth() + 1, 0));
      render();
    });

    // Insufficient-window actions
    getElement('adjustEndDateBtn')?.addEventListener('click', () => {
      _selectedEndDate = null;
      _selectingEndDate = true;
      _windowResult = null;
      render();
      container.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    getElement('useRecommendedBtn')?.addEventListener('click', () => {
      if (_windowResult && _windowResult.earliestCompletionDate && _selectedDate) {
        applySuggestedRange(formatDateKey(_selectedDate), _windowResult.earliestCompletionDate);
      }
    });

    renderProjectPreferences();
  }

  function formatDateDisplay(d) {
    if (!d) return '';
    const dt = new Date(d);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
  }

  async function handleProjectDateSelect(dateStr) {
    const parts = dateStr.split('-');
    const clickedDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    let pickedStart = false;

    if (!_selectedDate || _selectingEndDate) {
      if (!_selectedDate) {
        _selectedDate = clickedDate;
        pickedStart = true;
        _selectedEndDate = null;
        _selectingEndDate = true;
        _lastValidationResult = null;
        _windowResult = null;
      } else if (_selectingEndDate) {
        const startKey = formatDateKey(_selectedDate);
        const clickedKey = formatDateKey(clickedDate);

        if (clickedKey <= startKey) {
          _selectedDate = clickedDate;
          pickedStart = true;
          _selectedEndDate = null;
          _selectingEndDate = true;
          _lastValidationResult = null;
          _windowResult = null;
        } else {
          _selectedEndDate = clickedDate;
          _selectingEndDate = false;
          _lastValidationResult = null;
          _windowResult = null;
        }
      }
    } else {
      _selectedDate = clickedDate;
      pickedStart = true;
      _selectedEndDate = null;
      _selectingEndDate = true;
      _lastValidationResult = null;
      _windowResult = null;
    }

    _selectedSlot = null;
    render();
    syncProjectSelection();

    if (pickedStart) {
      if (!_endDatePromptShown) {
        _endDatePromptShown = true;
        if (typeof Swal !== 'undefined') {
          Swal.fire({
            icon: 'info',
            title: 'Start date selected',
            text: 'Now choose the latest date you want the service finished. Dates that do not allow enough time are unavailable.',
            confirmButtonText: 'Choose finish date',
          });
        }
      }
      if (!earliestFeasibleProjectEndDate(formatDateKey(_selectedDate), _projectAvailability, projectRequiredHours())) {
        const laterDate = new Date(_selectedDate);
        laterDate.setDate(laterDate.getDate() + 75);
        ensureProjectAvailabilityThrough(laterDate);
      }
    }

    if (_selectedDate && _selectedEndDate && !_selectingEndDate) {
      const isValid = await validateProjectRange();
      if (_syncGlobalState) window.syncScheduleNextAction?.();

      if (isValid) {
        if (_onSelectCb) {
          _onSelectCb(getProjectSelection());
        } else if (typeof showStep === 'function') {
          showStep(_nextStep);
          if (typeof updateStepper === 'function') updateStepper(_nextStep);
        }
      }
    }
  }

  /**
   * Validate the selected preferred window against available technician
   * capacity. The range is treated as a PREFERRED WINDOW: unavailable dates
   * inside it are skipped and feasibility is judged on total technician-hours.
   * Returns true when the window can accommodate the project.
   */
  async function validateProjectRange() {
    if (!_selectedDate || !_selectedEndDate) return false;

    _isValidating = true;
    _windowResult = null;
    _windowError = null;
    render();

    try {
      const requiredHours = Math.max(1, Math.round((_totalEstimatedMinutes / 60) * 10) / 10);
      const totalUnits = getCustomerUnitTotal();

      const resp = await fetch('/api/projects/window-availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: formatDateKey(_selectedDate),
          endDate: formatDateKey(_selectedEndDate),
          requiredHours,
          totalUnits,
        }),
      });

      if (!resp.ok) {
        // Transport/API failure (e.g. 404 when the server hasn't been
        // restarted) — NOT a genuine capacity verdict.
        _windowResult = null;
        _windowError = 'Unable to verify technician availability right now (the scheduling service may be out of date). Please try again shortly.';
        _isValidating = false;
        render();
        return false;
      }

      _windowResult = await resp.json();
      _windowError = null;
      _isValidating = false;
      render();
      syncProjectSelection();

      // Keep the capacity verdict and the next scheduling preference in view,
      // especially after the mobile calendar has pushed them below the fold.
      setTimeout(() => {
        const target = getElement('projectRangeValidation') || getElement('projectPrefs');
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 100);

      if (!_windowResult.sufficient) {
        return false;
      }

      return true;
    } catch (e) {
      console.error('EnterpriseCalendar: range validation error', e);
      _windowResult = null;
      _windowError = 'Network error while checking technician availability. Please check your connection and try again.';
      _isValidating = false;
      render();
      return false;
    }
  }

  function getProjectSelection() {
    const prefs = readProjectPrefs();
    return {
      date: _selectedDate,
      preferredStartDate: _selectedDate,
      startDate: _selectedDate,
      endDate: _selectedEndDate,
      preferences: prefs
    };
  }

  /**
   * Render the optional customer scheduling-preferences panel after a date
   * is chosen. Preferences (not confirmed schedule): preferred working days,
   * preferred site access time, completion deadline.
   */
  function renderProjectPreferences() {
    const prefsHost = getElement('projectPrefs');
    if (!prefsHost) return;

    prefsHost.classList.remove('d-none');

    // Compute range display
    const rangeDisplay = _selectedDate && _selectedEndDate
      ? `<span class="ent-range-selected">${formatDateDisplay(_selectedDate)} <i class="bi bi-arrow-right mx-1"></i> ${formatDateDisplay(_selectedEndDate)}</span>`
      : _selectedDate
        ? `<span class="ent-range-partial">${formatDateDisplay(_selectedDate)} — select end date above</span>`
        : '<span class="text-muted">Not selected</span>';

    // Count calendar days and holidays / non-working days in the selected
    // range so the note reflects real capacity-bearing days.
    let workingDaysCount = 0;
    let excludedDaysCount = 0;
    if (_selectedDate && _selectedEndDate) {
      const excludedKeys = new Set();
      (_holidaysData?.holidays || []).forEach(h => excludedKeys.add(formatDateKey(new Date(h.date))));
      (_holidaysData?.nonWorkingDays || []).forEach(n => excludedKeys.add(formatDateKey(new Date(n.date))));
      const cursor = new Date(_selectedDate); cursor.setHours(0, 0, 0, 0);
      const end = new Date(_selectedEndDate); end.setHours(0, 0, 0, 0);
      while (cursor <= end) {
        workingDaysCount++;
        if (excludedKeys.has(formatDateKey(cursor))) excludedDaysCount++;
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    prefsHost.innerHTML = `
      <div class="ent-project-prefs">
        <div class="ent-project-prefs-title"><i class="bi bi-sliders"></i>Optional Scheduling Preferences</div>
        <p class="ent-project-prefs-note">These are preferences only. The Operations Team will prepare the final multi-day schedule based on technician availability, company workload, and your selected date range.</p>

        <div class="ent-pref-group">
          <label class="ent-pref-label">Preferred Project Window</label>
          <div class="ent-range-display">${rangeDisplay}</div>
          ${workingDaysCount > 0 ? `<div class="ent-project-prefs-note mt-1">${workingDaysCount} calendar day${workingDaysCount > 1 ? 's' : ''} selected${excludedDaysCount > 0 ? ` &middot; ${excludedDaysCount} holiday/non-working day${excludedDaysCount > 1 ? 's' : ''} in this window` : ''}. Unavailable dates inside the window are skipped — the end date is the latest acceptable completion date.</div>` : ''}
        </div>

        <div class="ent-pref-group ent-pref-time-group">
          <label class="ent-pref-label">Preferred Daily Site Arrival</label>
          <p class="ent-project-prefs-note mb-2">Choose when technicians may arrive on scheduled workdays. This is a preference, not an exact appointment time.</p>
          <div class="ent-pref-chips ent-pref-time-options" id="prefWorkingHours" role="group" aria-label="Preferred daily site arrival">
            <button type="button" class="ent-pref-chip${_projectPreferences.preferredWorkingHours === 'morning' ? ' active' : ''}" data-hours="morning" aria-pressed="${_projectPreferences.preferredWorkingHours === 'morning'}"><strong>Morning</strong><small>8:00 AM–12:00 PM</small></button>
            <button type="button" class="ent-pref-chip${_projectPreferences.preferredWorkingHours === 'afternoon' ? ' active' : ''}" data-hours="afternoon" aria-pressed="${_projectPreferences.preferredWorkingHours === 'afternoon'}"><strong>Afternoon</strong><small>12:00 PM–5:00 PM</small></button>
          </div>
        </div>

        ${buildProjectEstimateHtml()}

        <div class="ent-pref-group">
          <label class="ent-pref-label">Preferred Working Days</label>
          <div class="ent-pref-chips" id="prefWorkingDays" role="group" aria-label="Preferred working days">
            ${WORKING_DAY_KEYS.map(k => `<button type="button" class="ent-pref-chip${_projectPreferences.workingDays.includes(k) ? ' active' : ''}" data-day="${k}" aria-pressed="${_projectPreferences.workingDays.includes(k)}">${k.charAt(0).toUpperCase() + k.slice(1)}</button>`).join('')}
          </div>
        </div>

        <div class="ent-pref-group">
          <label class="ent-pref-label" for="prefTotalUnits">Total Units <span class="text-muted fw-normal">(e.g. rooms, floors, buildings)</span></label>
          <input type="number" class="form-control form-control-sm" id="prefTotalUnits" min="1" max="40" value="${Math.min(40, Math.max(1, getCustomerUnitTotal()))}" readonly style="max-width:240px;border-radius:10px;">
          <div class="ent-project-prefs-note mt-1">Calculated from the quantities entered for all Core and Repair services.</div>
        </div>

        <div id="projectPrefsError" class="text-danger small mt-2 d-none"></div>
      </div>
    `;

    prefsHost.querySelectorAll('#prefWorkingDays .ent-pref-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('active');
        chip.setAttribute('aria-pressed', String(chip.classList.contains('active')));
        _projectPreferences.workingDays = Array.from(
          prefsHost.querySelectorAll('#prefWorkingDays .ent-pref-chip.active'),
          selected => selected.dataset.day,
        );
        syncProjectSelection();
      });
    });
    prefsHost.querySelectorAll('#prefWorkingHours .ent-pref-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        prefsHost.querySelectorAll('#prefWorkingHours .ent-pref-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        prefsHost.querySelectorAll('#prefWorkingHours .ent-pref-chip').forEach(c => {
          c.setAttribute('aria-pressed', String(c === chip));
        });
        _projectPreferences.preferredWorkingHours = chip.dataset.hours;
        syncProjectSelection();
      });
    });
    const units = prefsHost.querySelector('#prefTotalUnits');
    if (units) units.addEventListener('change', syncProjectSelection);
  }

  /**
   * Project estimate + availability summary + draft schedule preview for the
   * selected preferred window. Renders nothing until a full window exists and
   * has been validated (_windowResult populated).
   */
  function buildProjectEstimateHtml() {
    if (!(_selectedDate && _selectedEndDate) || !_windowResult) return '';
    const wr = _windowResult;
    const t = wr.totals || {};
    const techs = wr.totalActiveTechnicians || 0;
    const units = getCustomerUnitTotal();
    const estHours = Math.round((_totalEstimatedMinutes / 60) * 10) / 10;
    const dailyTeam = techs * (wr.dailyHours || 8);
    const minDays = Math.max(1, Math.ceil(estHours / Math.max(1, dailyTeam)));

    let html = `
      <div class="ent-pref-group">
        <label class="ent-pref-label">Project Estimate</label>
        <div class="ent-est-grid">
          <div class="ent-est-item"><span class="ent-est-num">${units}</span><span class="ent-est-cap">units</span></div>
          <div class="ent-est-item"><span class="ent-est-num">${estHours}h</span><span class="ent-est-cap">estimated work</span></div>
          <div class="ent-est-item"><span class="ent-est-num">${minDays}</span><span class="ent-est-cap">min working day${minDays !== 1 ? 's' : ''}</span></div>
          <div class="ent-est-item"><span class="ent-est-num">${techs}</span><span class="ent-est-cap">technician${techs !== 1 ? 's' : ''} on team</span></div>
        </div>
      </div>`;

    if (Array.isArray(wr.days) && wr.days.length) {
      const stateLabel = (d) => {
        if (!d.isWorkingDay) return { text: d.reason || 'Non-working day', cls: 'muted' };
        if (d.status === 'full') return { text: 'Available', cls: 'ok' };
        if (d.status === 'partial') return { text: `Limited Capacity (${d.availableTechnicians} of ${d.totalTechnicians} technicians)`, cls: 'warn' };
        return { text: 'No Project Capacity', cls: 'bad' };
      };
      html += `
      <div class="ent-pref-group">
        <label class="ent-pref-label">Availability Summary</label>
        <div class="ent-avail-summary">
          ${wr.days.map(d => {
            const s = stateLabel(d);
            return `<div class="ent-avail-row"><span class="ent-avail-date"><i class="bi bi-calendar3 me-1"></i>${formatDateDisplay(d.date)}</span><span class="ent-avail-state ent-avail-${s.cls}">${s.text}</span><span class="ent-avail-hours">${d.capacityHours > 0 ? `${Math.round(d.capacityHours * 10) / 10}h` : ''}</span></div>`;
          }).join('')}
          <div class="ent-avail-total">
            <span>Available capacity in window: <strong>${t.totalAvailableHours ?? 0} technician-hours</strong> (${t.workableDays ?? 0} workable day(s))</span>
          </div>
          ${wr.requiredHours ? `<div class="ent-avail-total"><span>Required project capacity: <strong>${wr.requiredHours} technician-hours</strong></span></div>` : ''}
        </div>
      </div>`;
    }

    if (wr.sufficient) {
      html += `
      <div class="ent-pref-group">
        <label class="ent-pref-label">Draft Schedule Preview</label>
        <p class="ent-project-prefs-note mb-2">Tentative allocation of work across available days — finalized by the Operations Team.</p>
        <div class="ent-schedule-preview">
          ${(wr.draftSchedule || []).map(e => e.status === 'work'
            ? `<div class="ent-sched-row ent-sched-work"><i class="bi bi-check2-circle me-1"></i><strong>${formatDateDisplay(e.date)}</strong><span>${e.units != null ? `${e.units} unit${e.units !== 1 ? 's' : ''}` : `${e.hours}h`}${e.units != null ? ` (${e.hours}h)` : ''}</span></div>`
            : `<div class="ent-sched-row ent-sched-skip"><i class="bi bi-dash-circle me-1"></i><strong>${formatDateDisplay(e.date)}</strong><span class="text-muted">Skipped — ${e.reason || 'unavailable'}</span></div>`
          ).join('')}
          <div class="ent-sched-row ent-sched-done"><i class="bi bi-flag-fill me-1"></i><strong>Project Complete${wr.estimatedCompletionDate ? ` — ${formatDateDisplay(wr.estimatedCompletionDate)}` : ''}</strong></div>
        </div>
      </div>`;
    }

    return html;
  }

  function readProjectPrefs() {
    const prefs = { workingDays: [..._projectPreferences.workingDays], preferredWorkingHours: _projectPreferences.preferredWorkingHours, completionDeadline: null, totalUnits: 1, startDate: null };
    const daysHost = getElement('prefWorkingDays');
    if (daysHost) {
      prefs.workingDays = Array.from(daysHost.querySelectorAll('.ent-pref-chip.active'), c => c.dataset.day);
      _projectPreferences.workingDays = [...prefs.workingDays];
    }
    const hoursHost = getElement('prefWorkingHours');
    if (hoursHost) {
      const active = hoursHost.querySelector('.ent-pref-chip.active');
      prefs.preferredWorkingHours = active ? active.dataset.hours : 'morning';
      _projectPreferences.preferredWorkingHours = prefs.preferredWorkingHours;
    }
    prefs.startDate = _selectedDate ? formatDateKey(_selectedDate) : null;
    prefs.completionDeadline = _selectedEndDate ? formatDateKey(_selectedEndDate) : null;
    const units = getElement('prefTotalUnits');
    if (units && units.value) {
      const n = parseInt(units.value, 10);
      prefs.totalUnits = Number.isFinite(n) ? Math.min(40, Math.max(1, n)) : 1;
    }
    return prefs;
  }

  function syncProjectSelection() {
    if (!_selectedDate) return;
    const prefs = readProjectPrefs();
    const selection = {
      date: _selectedDate,
      preferredStartDate: _selectedDate,
      startDate: _selectedDate,
      endDate: _selectedEndDate || null,
      preferences: prefs
    };
    const wrWindow = _windowResult && _windowResult.window ? _windowResult.window : null;
    if (wrWindow && _selectedDate && _selectedEndDate &&
        wrWindow.startDate === formatDateKey(_selectedDate) &&
        wrWindow.endDate === formatDateKey(_selectedEndDate)) {
      selection.windowVerdict = {
        sufficient: !!_windowResult.sufficient,
        requiredHours: _windowResult.requiredHours ?? null,
        totalAvailableHours: _windowResult.totals?.totalAvailableHours ?? null,
        estimatedCompletionDate: _windowResult.estimatedCompletionDate || null,
        earliestCompletionDate: _windowResult.earliestCompletionDate || null,
      };
    }
    if (_syncGlobalState && window.BookingState) {
      window.BookingState.selectedDate = _selectedDate;
      window.BookingState.isProject = true;
      window.BookingState.projectScheduling = selection;
      if (typeof window.saveBookingProgress === 'function') window.saveBookingProgress();
    }
    if (_syncGlobalState) window.syncScheduleNextAction?.();
    if (_syncGlobalState && window.RepairState) {
      window.RepairState.preferredDate = _selectedDate;
      window.RepairState.preferredTime = '';
      window.RepairState.isProject = true;
      window.RepairState.projectScheduling = selection;
    }
  }

  function getSelectedDate() { return _selectedDate; }
  function getSelectedEndDate() { return _selectedEndDate; }
  function getSelectedSlot() { return _selectedSlot; }
  function isProjectMode() { return _mode === 'project'; }
  function getMode() { return _mode; }
  function getWindowVerdict() { return _windowResult; }

  function resetRange() {
    _selectedDate = null;
    _selectedEndDate = null;
    _selectedSlot = null;
    _selectingEndDate = false;
    _lastValidationResult = null;
    _windowResult = null;
    _windowError = null;
    _isValidating = false;
    if (_syncGlobalState && window.BookingState) {
      window.BookingState.selectedDate = null;
      window.BookingState.selectedTimeSlot = null;
      window.BookingState.projectScheduling = null;
      if (typeof window.saveBookingProgress === 'function') window.saveBookingProgress();
      window.syncScheduleNextAction?.();
    }
    render();
  }

  // Sum of the per-service quantities the customer entered in the booking UI.
  // Used to pre-fill the "Total Units" field so the project reflects reality.
  function getCustomerUnitTotal() {
    if (!_syncGlobalState) return _quantity;
    const sel = (window.BookingState && window.BookingState.selectedServices) ||
                (window.RepairState && window.RepairState.selectedServices) || [];
    const total = Array.isArray(sel) ? sel.reduce((t, s) => t + (Number(s.quantity) || 1), 0) : 0;
    return total > 0 ? total : 1;
  }

  function onSelect(fn) {
    if (typeof fn === 'function') _onSelectCb = fn;
  }

  /**
   * Apply a suggested date range from the validation result.
   * Updates the selected dates and re-validates.
   */
  async function applySuggestedRange(suggestedStart, suggestedEnd) {
    const partsStart = suggestedStart.split('-');
    const partsEnd = suggestedEnd.split('-');
    _selectedDate = new Date(parseInt(partsStart[0]), parseInt(partsStart[1]) - 1, parseInt(partsStart[2]));
    _selectedEndDate = new Date(parseInt(partsEnd[0]), parseInt(partsEnd[1]) - 1, parseInt(partsEnd[2]));
    _selectingEndDate = false;
    _lastValidationResult = null;
    _windowResult = null;

    // Navigate calendar to the suggested start month
    _currentMonth = new Date(_selectedDate.getFullYear(), _selectedDate.getMonth(), 1);

    render();
    syncProjectSelection();

    // Auto-validate the suggested range
    const isValid = await validateProjectRange();
    if (_syncGlobalState) window.syncScheduleNextAction?.();
    if (isValid) {
      if (_onSelectCb) {
        _onSelectCb(getProjectSelection());
      } else if (typeof showStep === 'function') {
        showStep(_nextStep);
        if (typeof updateStepper === 'function') updateStepper(_nextStep);
      }
    }
  }

  /**
   * Clear the current selection and validation state.
   */
  function resetValidation() {
    _lastValidationResult = null;
    _windowResult = null;
    _isValidating = false;
  }

  return {
    init,
    render,
    refresh,
    getSelectedDate,
    getSelectedEndDate,
    getSelectedSlot,
    validateSelectedSlot,
    onSelect,
    isProjectMode,
    getMode,
    getWindowVerdict,
    earliestFeasibleProjectEndDate,
    getCustomerUnitTotal,
    formatDateKey,
    minutesToTime,
    resetRange,
    applySuggestedRange,
    resetValidation,
  };
})();

window.EnterpriseCalendar = EnterpriseCalendar;
