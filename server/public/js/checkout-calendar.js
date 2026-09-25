/**
 * CheckoutCalendar — Capacity-Based Scheduling for Product Orders
 * Uses the shared /api/schedule availability and time-slot endpoints.
 * Matches EnterpriseCalendar workload, advance-notice, and 30-minute start logic.
 */

class CheckoutCalendar {
    constructor(containerId, options) {
        this.container = document.getElementById(containerId);
        if (!this.container) return;

        this.options = Object.assign({
            fulfillmentType: 'delivery_installation',
            duration: 60,
            quantity: 1,
            travelTime: 30,
            onDateSelect: () => {},
            onTimeSelect: () => {}
        }, options);

        this.state = {
            activeMonth: new Date(),
            selectedDate: null,
            selectedTimeSlot: null,
            duration: Math.max(30, Number(this.options.duration) || 60),
            quantity: Math.max(1, Number(this.options.quantity) || 1),
            travelTime: Math.max(0, Number(this.options.travelTime) || 30)
        };
        this.state.activeMonth.setDate(1);
        this.state.activeMonth.setHours(0, 0, 0, 0);

        this.scheduleData = { availableDates: [] };
        this.holidaysData = { holidays: [], nonWorkingDays: [] };

        this._injectStyles();
        this.initUI();
        this.fetchData();
    }

    _injectStyles() {
        if (document.getElementById('checkout-ent-calendar-style')) return;
        const style = document.createElement('style');
        style.id = 'checkout-ent-calendar-style';
        style.innerHTML = `
            .co-ent-calendar {
                background: #ffffff;
                border: 1px solid #e2e8f0;
                border-radius: 12px;
                overflow: hidden;
                box-shadow: 0 1px 3px rgba(0,0,0,0.04);
                width: 100%;
                max-width: 100%;
                box-sizing: border-box;
            }
            .co-cal-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 12px 18px;
                background: #0f172a;
                color: #fff; position: relative; overflow: hidden;
            }
            .co-cal-header h6 { margin: 0; font-size: 0.95rem; font-weight: 600; letter-spacing: -0.01em; position: relative; z-index: 1; }
            .co-cal-nav-btn {
                width: 32px; height: 32px; border-radius: 8px;
                border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.08); color: #fff;
                display: flex; align-items: center; justify-content: center;
                cursor: pointer; transition: all 0.15s ease; font-size: 0.8rem;
                position: relative; z-index: 1;
            }
            .co-cal-nav-btn:hover { background: rgba(255,255,255,0.15); }
            .co-cal-nav-btn:active { transform: scale(0.97); }
            .co-cal-mode {
                display: flex; align-items: center; gap: 7px;
                padding: 8px 18px; background: #f8fafc;
                border-bottom: 1px solid #e2e8f0;
                font-size: 0.72rem; color: #64748b; font-weight: 500;
            }
            .co-cal-mode .mode-dot { width: 7px; height: 7px; border-radius: 50%; background: #10b981; flex-shrink: 0; }
            .co-cal-legend {
                display: flex; flex-wrap: wrap; gap: 12px;
                padding: 8px 18px; border-bottom: 1px solid #f1f5f9; background: #fafafa;
            }
            .co-cal-legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.66rem; color: #475569; font-weight: 600; }
            .co-cal-legend-dot { width: 12px; height: 12px; border-radius: 4px; flex-shrink: 0; border: 1px solid rgba(0,0,0,0.06); }
            .co-cal-legend-dot.available { background: rgba(16,185,129,0.12); border-color: rgba(16,185,129,0.2); }
            .co-cal-legend-dot.limited { background: rgba(245,158,11,0.12); border-color: #fcd34d; }
            .co-cal-legend-dot.full { background: rgba(239,68,68,0.1); border-color: rgba(239,68,68,0.15); }
            .co-cal-legend-dot.holiday { background: repeating-linear-gradient(45deg, rgba(239,68,68,0.04), rgba(239,68,68,0.04) 2px, rgba(239,68,68,0.08) 2px, rgba(239,68,68,0.08) 4px); border-color: rgba(239,68,68,0.15); }
            .co-cal-legend-dot.non-working { background: repeating-linear-gradient(45deg, rgba(100,116,139,0.04), rgba(100,116,139,0.04) 2px, rgba(100,116,139,0.08) 2px, rgba(100,116,139,0.08) 4px); border-color: rgba(100,116,139,0.15); }
            .co-cal-days { display: grid; grid-template-columns: repeat(7,minmax(0,1fr)); padding: 8px 12px 2px; }
            .co-cal-day-name { text-align: center; font-size: 0.65rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; padding: 4px 0; }
            .co-cal-grid { display: grid; grid-template-columns: repeat(7,minmax(0,1fr)); gap: 4px; padding: 2px 12px 12px; }
            .co-cal-cell {
                position: relative; min-width: 0; min-height: 58px; border-radius: 8px;
                display: flex; flex-direction: column; align-items: center; justify-content: center;
                font-size: 0.85rem; font-weight: 600; cursor: default;
                transition: all 0.15s ease; border: 1px solid transparent;
                padding: 5px 2px; background: #fafafa; box-sizing: border-box;
            }
            .co-cal-cell.empty { background: transparent; cursor: default; }
            .co-cal-cell.past { background: #f8fafc; color: #94a3b8; border-color: #f1f5f9; opacity: 0.5; }
            .co-cal-cell.past .co-cal-reason { display: none; }
            .co-cal-cell.available { background: rgba(16,185,129,0.06); color: #065f46; border-color: rgba(16,185,129,0.15); cursor: pointer; }
            .co-cal-cell.available:hover { background: rgba(16,185,129,0.12); border-color: rgba(16,185,129,0.3); transform: translateY(-1px); }
            .co-cal-cell.limited { background: rgba(245,158,11,0.06); color: #92400e; border-color: rgba(245,158,11,0.15); cursor: pointer; }
            .co-cal-cell.limited:hover { background: rgba(245,158,11,0.12); border-color: rgba(245,158,11,0.3); transform: translateY(-1px); }
            .co-cal-cell.full { background: rgba(239,68,68,0.04); color: #991b1b; border-color: rgba(239,68,68,0.1); }
            .co-cal-cell.holiday { background: repeating-linear-gradient(45deg, rgba(239,68,68,0.03), rgba(239,68,68,0.03) 2px, rgba(239,68,68,0.06) 2px, rgba(239,68,68,0.06) 4px); color: #b91c1c; border-color: rgba(239,68,68,0.15); border-style: dashed; }
            .co-cal-cell.non-working { background: repeating-linear-gradient(45deg, rgba(100,116,139,0.03), rgba(100,116,139,0.03) 2px, rgba(100,116,139,0.06) 2px, rgba(100,116,139,0.06) 4px); color: #64748b; border-color: rgba(100,116,139,0.1); border-style: dashed; }
            .co-cal-cell.selected { background: #0f172a !important; color: #fff !important; border-color: transparent !important; border-style: solid !important; }
            .co-cal-cell.selected .co-cal-slots, .co-cal-cell.selected .co-cal-reason { color: rgba(255,255,255,0.8) !important; }
            .co-cal-cell.today::after { content: ''; position: absolute; bottom: 4px; width: 5px; height: 5px; border-radius: 50%; background: #0f172a; }
            .co-cal-cell.selected.today::after { background: #fff; }
            .co-cal-date { font-size: 0.85rem; font-weight: 600; line-height: 1; }
            .co-cal-slots { font-size: 0.58rem; font-weight: 700; margin-top: 5px; line-height: 1.2; }
            .co-cal-cell.available .co-cal-slots { color: #059669; }
            .co-cal-cell.limited .co-cal-slots { color: #d97706; }
            .co-cal-cell.full .co-cal-slots { color: #dc2626; }
            .co-cal-reason { font-size: 0.5rem; font-weight: 600; color: #64748b; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 2px; margin-top: 1px; }
            .co-cal-cell.holiday .co-cal-reason { color: #dc2626; }
            .co-cal-cell.non-working .co-cal-reason { color: #64748b; }
            .co-cal-tooltip { position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); background: #0f172a; color: #f8fafc; padding: 6px 10px; border-radius: 6px; font-size: 0.7rem; font-weight: 500; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity 0.15s ease; z-index: 100; box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-width: 190px; overflow: hidden; text-overflow: ellipsis; }
            .co-cal-tooltip::after { content: ''; position: absolute; top: 100%; left: 50%; transform: translateX(-50%); border: 4px solid transparent; border-top-color: #0f172a; }
            .co-cal-cell:hover .co-cal-tooltip { opacity: 1; }
            .co-time-section { margin-top: 12px; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
            .co-time-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; }
            .co-time-header h6 { margin: 0; font-size: 0.8rem; font-weight: 600; color: #0f172a; display: flex; align-items: center; gap: 6px; }
            .co-time-header h6 i { color: #0f172a; font-size: 0.85rem; }
            .co-time-header .co-time-date { font-size: 0.7rem; font-weight: 600; color: #0f172a; background: #f1f5f9; padding: 3px 8px; border-radius: 6px; }
            .co-time-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; padding: 12px 14px; }
            .co-time-count { grid-column: 1/-1; margin: 0 0 6px; color: #475569; font-size: .76rem; font-weight: 600; }
            .co-time-slot {
                position: relative; padding: 10px 12px; border-radius: 8px;
                border: 1px solid #e2e8f0; background: #fafafa;
                cursor: pointer; transition: all 0.15s ease; overflow: hidden;
            }
            .co-time-slot::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: #0f172a; border-radius: 2px 0 0 2px; opacity: 0; transition: opacity 0.15s ease; }
            .co-time-slot:hover { background: #f1f5f9; border-color: #cbd5e1; transform: translateY(-1px); }
            .co-time-slot:hover::before { opacity: 0.5; }
            .co-time-slot:active { transform: translateY(0); }
            .co-time-slot.selected { background: #0f172a !important; border-color: transparent !important; color: #fff; }
            .co-time-slot.selected::before { opacity: 1; background: rgba(255,255,255,0.3); width: 2px; }
            .co-time-slot.selected .co-time-slot-label { color: #ffffff; }
            .co-time-slot.selected .co-time-slot-status { background: rgba(255,255,255,0.15); color: #ffffff; border: 1px solid rgba(255,255,255,0.2); }
            .co-time-slot.selected .co-time-slot-status::before { background: #ffffff; box-shadow: none; }
            .co-time-slot.unavailable { background: #fef2f2; border-color: rgba(239,68,68,0.1); cursor: not-allowed; opacity: 0.6; }
            .co-time-slot.unavailable::before { background: #ef4444; opacity: 0.4; }
            .co-time-slot.unavailable .co-time-slot-label { color: #6b7280; text-decoration: line-through; }
            .co-time-slot.past { background: #f8fafc; border-color: #f1f5f9; cursor: not-allowed; opacity: 0.4; }
            .co-time-slot.past::before { background: #94a3b8; opacity: 0.3; }
            .co-time-slot.past .co-time-slot-label { color: #94a3b8; }
            .co-time-slot-label { font-size: 0.82rem; font-weight: 600; color: #0f172a; line-height: 1.2; margin-bottom: 4px; }
            .co-time-slot-status { display: inline-flex; align-items: center; gap: 4px; font-size: 0.58rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 6px; border-radius: 4px; line-height: 1.4; }
            .co-time-slot-status::before { content: ''; width: 4px; height: 4px; border-radius: 50%; flex-shrink: 0; }
            .co-time-slot-status.available { background: rgba(16,185,129,0.08); color: #065f46; border: 1px solid rgba(16,185,129,0.12); }
            .co-time-slot-status.available::before { background: #10b981; }
            .co-time-slot-status.booked { background: rgba(239,68,68,0.06); color: #991b1b; border: 1px solid rgba(239,68,68,0.1); }
            .co-time-slot-status.booked::before { background: #ef4444; }
            .co-time-slot-status.past { background: rgba(100,116,139,0.06); color: #475569; border: 1px solid rgba(100,116,139,0.1); }
            .co-time-slot-status.past::before { background: #94a3b8; }
            .co-schedule-next { margin: 0 14px 14px; padding: 12px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; }
            .co-schedule-next[hidden] { display: none !important; }
            .co-schedule-next strong { display: block; color: #1e3a8a; font-size: .85rem; }
            .co-schedule-next span { display: block; color: #475569; font-size: .72rem; }
            .co-schedule-next button { border: 0; border-radius: 8px; background: #1d4ed8; color: #fff; padding: 10px 16px; font-size: .8rem; font-weight: 700; min-height: 42px; }
            .co-schedule-next button:hover { background: #1e40af; }
            .co-cal-cell:focus-visible, .co-time-slot:focus-visible, .co-schedule-next button:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
            .co-cal-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px 16px; color: #64748b; gap: 8px; font-size: 0.8rem; font-weight: 500; }
            .co-cal-loading .spinner-border { width: 1.2rem; height: 1.2rem; color: #0f172a; }
            .co-no-slots { text-align: center; padding: 24px 16px; color: #64748b; font-size: 0.82rem; font-weight: 500; }
            .co-no-slots i { display: block; font-size: 1.6rem; color: #cbd5e1; margin-bottom: 6px; }
            .co-cal-nav-btn:disabled { opacity: .35; cursor: not-allowed; }
            .co-cal-nav-btn:disabled:hover { background: rgba(255,255,255,0.08); }
            @media (max-width: 575px) {
                .co-cal-mode { display: none; }
                .co-cal-cell { min-height: 44px; border-radius: 6px; border-width: 1px; padding: 3px 1px; }
                .co-cal-date { font-size: 0.76rem; }
                .co-cal-slots { font-size: 0.46rem; }
                .co-cal-reason { font-size: .44rem; }
                .co-cal-legend { flex-wrap: nowrap; justify-content: center; gap: 10px; padding: 6px 8px; }
                .co-cal-legend-item { font-size: 0.6rem; }
                .co-cal-legend-dot { width: 10px; height: 10px; }
                .co-cal-legend-item:nth-child(n+4) { display: none; }
                .co-cal-header { padding: 10px 12px; }
                .co-cal-mode { padding: 7px 12px; font-size: .66rem; }
                .co-cal-days { padding-left: 8px; padding-right: 8px; }
                .co-cal-grid { gap: 3px; padding: 2px 8px 8px; }
                .co-time-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; padding: 8px; }
                .co-time-slot { padding: 8px 10px; }
                .co-time-header { padding: 8px 12px; align-items:flex-start; flex-direction:column; gap:5px; }
                .co-schedule-next button { width: 100%; }
                .co-cal-tooltip { display:none; }
            }
            @media (max-width: 380px) {
                .co-cal-day-name { font-size:.55rem; letter-spacing:0; }
                .co-cal-grid { gap:2px; padding-left:6px; padding-right:6px; }
                .co-cal-days { padding-left:6px; padding-right:6px; }
                .co-cal-cell { min-height:40px; }
                .co-cal-slots, .co-cal-reason { display:none; }
                .co-time-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
            }
        `;
        document.head.appendChild(style);
    }

    initUI() {
        const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        this.container.innerHTML = `
            <div class="co-ent-calendar">
                <div class="co-cal-header">
                    <button type="button" class="co-cal-nav-btn" id="coCalPrev"><i class="bi bi-chevron-left"></i></button>
                    <h6 id="coCalLabel">Month Year</h6>
                    <button type="button" class="co-cal-nav-btn" id="coCalNext"><i class="bi bi-chevron-right"></i></button>
                </div>
                <p class="co-cal-mode"><span class="mode-dot"></span><span>Choose an open date, then pick a start time.</span></p>
                <div class="co-cal-legend">
                    <div class="co-cal-legend-item"><span class="co-cal-legend-dot available"></span>Open</div>
                    <div class="co-cal-legend-item"><span class="co-cal-legend-dot limited"></span>Few left</div>
                    <div class="co-cal-legend-item"><span class="co-cal-legend-dot full"></span>Full</div>
                    <div class="co-cal-legend-item"><span class="co-cal-legend-dot holiday"></span>Holiday</div>
                    <div class="co-cal-legend-item"><span class="co-cal-legend-dot non-working"></span>Non-Working</div>
                </div>
                <div class="co-cal-days">${DAYS_SHORT.map(d => `<div class="co-cal-day-name">${d}</div>`).join('')}</div>
                <div class="co-cal-grid" id="coCalGrid"></div>
            </div>
            <div id="coTimeSection" class="co-time-section" style="display:none;">
                <div class="co-time-header">
                    <h6><i class="bi bi-clock"></i>Choose a start time</h6>
                    <span class="co-time-date" id="coTimeDateLabel"></span>
                </div>
                <div class="co-time-grid" id="coTimeGrid">
                    <div class="co-cal-loading"><div class="spinner-border" role="status"></div><span>Loading time slots...</span></div>
                </div>
                <div class="co-schedule-next" id="coScheduleNext" role="status" aria-live="polite" hidden>
                    <div><strong id="coScheduleNextTitle">Time selected</strong><span>Your delivery time is a request until we confirm your order.</span></div>
                    <button type="button" id="coScheduleNextButton">Continue to payment <i class="bi bi-arrow-right ms-1"></i></button>
                </div>
            </div>
        `;

        this.dom = {
            label: document.getElementById('coCalLabel'),
            grid: document.getElementById('coCalGrid'),
            prevBtn: document.getElementById('coCalPrev'),
            nextBtn: document.getElementById('coCalNext'),
            timeSection: document.getElementById('coTimeSection'),
            timeGrid: document.getElementById('coTimeGrid'),
            timeDateLabel: document.getElementById('coTimeDateLabel'),
            nextAction: document.getElementById('coScheduleNext'),
            nextTitle: document.getElementById('coScheduleNextTitle')
        };

        document.getElementById('coScheduleNextButton').addEventListener('click', () => window.wizardNext?.());

        this.dom.prevBtn.addEventListener('click', () => {
            if (this.dom.prevBtn.disabled) return;
            this.state.activeMonth.setMonth(this.state.activeMonth.getMonth() - 1);
            this.render();
        });
        this.dom.nextBtn.addEventListener('click', () => {
            this.state.activeMonth.setMonth(this.state.activeMonth.getMonth() + 1);
            this.render();
        });
    }

    setFulfillmentType(type) {
        this.options.fulfillmentType = type;
        if (!this.options.duration) {
            this.state.duration = type === 'delivery_installation' ? 120 : 60;
        }
        if (this.state.selectedDate) {
            this.loadTimeSlots(this.state.selectedDate);
        }
    }

    setDuration(minutes) {
        const nextDuration = Math.max(30, Number(minutes) || 60);
        if (nextDuration === this.state.duration) return;
        this.state.duration = nextDuration;
        this.options.duration = this.state.duration;
        this._resetScheduleSelection();
        this.fetchData();
    }

    setQuantity(quantity) {
        const nextQuantity = Math.max(1, Number(quantity) || 1);
        if (nextQuantity === this.state.quantity) return;
        this.state.quantity = nextQuantity;
        this.options.quantity = nextQuantity;
        this._resetScheduleSelection();
        this.fetchData();
    }

    setTravelTime(minutes) {
        const nextTravelTime = Math.max(0, Number(minutes) || 30);
        if (nextTravelTime === this.state.travelTime) return;
        this.state.travelTime = nextTravelTime;
        this.options.travelTime = nextTravelTime;
        this._resetScheduleSelection();
        this.fetchData();
    }

    _resetScheduleSelection() {
        this.state.selectedDate = null;
        this.state.selectedTimeSlot = null;
        if (this.dom.timeSection) this.dom.timeSection.style.display = 'none';
        this.dom.nextAction.hidden = true;
        this.options.onDateSelect('');
        this.options.onTimeSelect('');
    }

    async fetchData() {
        this.dom.grid.style.opacity = '0.5';
        try {
            const params = new URLSearchParams({
                duration: this.state.duration,
                quantity: this.state.quantity,
                travelTime: this.state.travelTime,
                mode: 'manual'
            });
            const [schRes, holRes, policyRes] = await Promise.all([
                fetch(`/api/schedule/available-dates?${params.toString()}`, { cache: 'no-store' }),
                fetch('/api/schedule/holidays-and-nonworking', { cache: 'no-store' }),
                fetch('/api/schedule/booking-policy', { cache: 'no-store' })
            ]);
            this.scheduleData = schRes.ok ? await schRes.json() : { availableDates: [], loadError: true };
            this.holidaysData = holRes.ok ? await holRes.json() : { holidays: [], nonWorkingDays: [] };
            if (policyRes.ok) window.__bookingPolicy = await policyRes.json();
            const projectThresholdHours = Number(window.__bookingPolicy?.largeProjectThresholdHours) || 8;
            if (this.state.quantity >= 8 || this.state.duration * this.state.quantity > projectThresholdHours * 60) {
                this.scheduleData = {
                    availableDates: [],
                    blocked: true,
                    message: 'This installation must be handled as a large-scale project.'
                };
            }
        } catch (e) {
            console.error('CheckoutCalendar: load error', e);
            this.scheduleData = { availableDates: [], loadError: true };
            this.holidaysData = { holidays: [], nonWorkingDays: [] };
        }
        this.dom.grid.style.opacity = '1';
        this.render();
        if (this.state.selectedDate && !this.scheduleData?.loadError) {
            const selectedTime = this.state.selectedTimeSlot?.startTime || '';
            this.selectDate(this._formatKey(this.state.selectedDate), true, selectedTime);
        }
    }

    _formatKey(d) {
        const dt = new Date(d);
        return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
    }

    render() {
        const year = this.state.activeMonth.getFullYear();
        const month = this.state.activeMonth.getMonth();
        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const today = new Date(); today.setHours(0,0,0,0);
        const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

        this.dom.label.textContent = `${MONTHS[month]} ${year}`;

        if (this.scheduleData?.loadError) {
            this.dom.grid.innerHTML = '<div class="co-no-slots" style="grid-column:1/-1"><i class="bi bi-wifi-off"></i>Could not check open dates. Please try again.<br><button type="button" class="btn btn-outline-primary btn-sm mt-2" id="coRetryDates">Try again</button></div>';
            document.getElementById('coRetryDates')?.addEventListener('click', () => this.fetchData());
            this.dom.timeSection.style.display = 'none';
            return;
        }

        if (this.scheduleData?.blocked) {
            this.dom.grid.innerHTML = '<div class="co-no-slots" style="grid-column:1/-1"><i class="bi bi-kanban"></i>This installation requires project scheduling because it exceeds one appointment window. Reduce the quantity or contact Operations.</div>';
            this.dom.timeSection.style.display = 'none';
            return;
        }

        const currentMonth = new Date();
        currentMonth.setDate(1);
        currentMonth.setHours(0,0,0,0);
        this.dom.prevBtn.disabled = this.state.activeMonth <= currentMonth;
        this.dom.prevBtn.setAttribute('aria-label', 'Previous month');
        this.dom.nextBtn.setAttribute('aria-label', 'Next month');

        const availMap = {};
        (this.scheduleData?.availableDates || []).forEach(d => { availMap[d.date] = d; });

        const holMap = {};
        (this.holidaysData?.holidays || []).forEach(h => {
            holMap[this._formatKey(new Date(h.date))] = { type: 'holiday', name: h.name || 'Holiday' };
        });
        (this.holidaysData?.nonWorkingDays || []).forEach(n => {
            const key = this._formatKey(new Date(n.date));
            if (!holMap[key]) holMap[key] = { type: 'non-working', name: n.reason || 'Non-working day' };
        });

        let html = '';
        for (let i = 0; i < firstDay; i++) {
            html += `<div class="co-cal-cell empty"></div>`;
        }

        for (let day = 1; day <= daysInMonth; day++) {
            const dateObj = new Date(year, month, day);
            const key = this._formatKey(dateObj);
            // Product checkout requires a future delivery date. Today is not
            // selectable even if the shared availability API reports capacity.
            const isPast = key <= this._formatKey(today);
            const isToday = key === this._formatKey(today);
            const holInfo = holMap[key];
            const availInfo = availMap[key];

            let cellClass = 'co-cal-cell';
            let tooltipText = '';
            let reasonText = '';
            let slotsText = '';
            let clickable = false;

            if (isPast) {
                cellClass += ' past';
                tooltipText = isToday ? 'Choose a future date' : 'Past date';
            } else if (isToday) {
                // TODAY takes precedence over everything else.
                // The server may still report today as having slots even though
                // the working hours have passed, so we label it clearly.
                if (holInfo && holInfo.type === 'holiday') {
                    cellClass += ' holiday';
                    reasonText = holInfo.name;
                    tooltipText = `Holiday: ${holInfo.name}`;
                } else if (availInfo && availInfo.availableSlots > 0) {
                    // Slots remain on paper, but if the booking window has passed
                    // they are no longer bookable — show as closed.
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
                        slotsText = count <= 3 ? 'Few left' : 'Open';
                        tooltipText = 'Open for booking today';
                    }
                } else if (availInfo && availInfo.availableSlots === 0) {
                    cellClass += ' non-working';
                    reasonText = 'No Slots Today';
                    tooltipText = 'All slots for today are booked';
                } else if (holInfo) {
                    cellClass += ' non-working';
                    reasonText = 'Closed Today';
                    tooltipText = 'No remaining slots for today';
                } else {
                    cellClass += ' non-working';
                    reasonText = 'Closed Today';
                    tooltipText = 'No remaining slots for today';
                }
            } else if (availInfo) {
                if (availInfo.availableSlots === 0) {
                    cellClass += ' full';
                    reasonText = 'Fully Booked';
                    tooltipText = 'All slots booked for this date';
                } else if (availInfo.availableSlots <= 3) {
                    cellClass += ' limited';
                    clickable = true;
                    const count = availInfo.availableSlots;
                    slotsText = 'Few left';
                    tooltipText = 'Few booking openings left';
                } else {
                    cellClass += ' available';
                    clickable = true;
                    slotsText = 'Open';
                    tooltipText = 'Open for booking';
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
                cellClass += ' non-working';
                reasonText = 'Non-Working Day';
                tooltipText = 'Not a working day';
            }

            if (this.state.selectedDate && key === this._formatKey(this.state.selectedDate)) {
                cellClass += ' selected';
            }
            if (isToday) cellClass += ' today';

            const dateLabel = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
            const accessibleState = clickable ? (slotsText === 'Few left' ? 'few times left' : 'times available') : (reasonText || 'not available');
            html += `<div class="${cellClass}" data-date="${key}" aria-label="${dateLabel}, ${accessibleState}" ${clickable ? 'role="button" tabindex="0"' : ''}>`;
            if (tooltipText) html += `<span class="co-cal-tooltip">${tooltipText}</span>`;
            html += `<span class="co-cal-date">${day}</span>`;
            if (slotsText) html += `<span class="co-cal-slots">${slotsText}</span>`;
            if (reasonText) html += `<span class="co-cal-reason">${reasonText}</span>`;
            html += `</div>`;
        }

        this.dom.grid.innerHTML = html;

        this.dom.grid.querySelectorAll('.co-cal-cell.available, .co-cal-cell.limited').forEach(cell => {
            cell.addEventListener('click', () => this.selectDate(cell.dataset.date));
            cell.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.selectDate(cell.dataset.date); }
            });
        });
    }

    selectDate(dateStr, silent = false, restoredTime = '') {
        const today = new Date(); today.setHours(0,0,0,0);
        const parts = dateStr.split('-');
        const dateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        if (dateObj <= today) return;
        this.state.selectedDate = dateObj;
        this.state.selectedTimeSlot = restoredTime ? { startTime: restoredTime, label: restoredTime, startMinutes: this._timeToMinutes(restoredTime) } : null;
        this.dom.nextAction.hidden = true;
        this.render();

        if (!silent) {
            this.options.onDateSelect(dateStr);
            // A time belongs to the previously selected date and must not
            // remain valid after the customer chooses a different day.
            this.options.onTimeSelect('');
        }

        this.dom.timeSection.style.display = 'block';
        this.dom.timeDateLabel.textContent = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        this.dom.timeGrid.innerHTML = '<div class="co-cal-loading"><div class="spinner-border" role="status"></div><span>Loading time slots...</span></div>';

        return this.loadTimeSlots(dateObj);
    }

    restoreSelection(dateStr, timeStr) {
        if (!dateStr) return;
        this.state.activeMonth = new Date(`${dateStr}T00:00:00`);
        this.state.activeMonth.setDate(1);
        return this.selectDate(dateStr, true, timeStr);
    }

    _syncNextAction(date) {
        const time = this.state.selectedTimeSlot?.startTime;
        this.dom.nextAction.hidden = !time;
        if (time) this.dom.nextTitle.textContent = `${date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${this._formatDisplayTime(time)}`;
    }

    async loadTimeSlots(date) {
        const formatDateKey = (d) => {
            const dt = new Date(d);
            return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
        };
        const dateStr = formatDateKey(date);
        const requestId = (this._timeRequestId || 0) + 1;
        this._timeRequestId = requestId;
        this.dom.nextAction.hidden = true;

        try {
            const params = new URLSearchParams({
                date: dateStr,
                duration: this.state.duration,
                quantity: this.state.quantity,
                travelTime: this.state.travelTime
            });
            const resp = await fetch(`/api/schedule/time-slots?${params.toString()}`, { cache: 'no-store' });
            if (!resp.ok) throw new Error('time-slots fetch failed');
            const data = await resp.json();
            if (requestId !== this._timeRequestId) return;

            if (data.blocked) {
                this.dom.timeGrid.innerHTML = '<div class="co-no-slots"><i class="bi bi-kanban"></i>This installation requires project scheduling. Reduce the quantity or contact Operations.</div>';
                this.state.selectedTimeSlot = null;
                this.dom.nextAction.hidden = true;
                this.options.onTimeSelect('');
                return;
            }

            if (data.timeSlots && data.timeSlots.length > 0) {
                const now = new Date();
                const isToday = dateStr === formatDateKey(now);
                const currentMinutes = now.getHours() * 60 + now.getMinutes();
                const bufferMinutes = 30;
                const cutoff = currentMinutes + bufferMinutes;
                const minAdvance = (window.__bookingPolicy && window.__bookingPolicy.minAdvanceNoticeMinutes) || 120;
                const earliestMs = now.getTime() + minAdvance * 60000;
                const earliestDate = new Date(earliestMs);
                let earliestMinutes = 0;
                if (isToday) {
                    if (earliestDate.toDateString() === date.toDateString()) {
                        earliestMinutes = earliestDate.getHours() * 60 + earliestDate.getMinutes();
                    } else {
                        earliestMinutes = 24 * 60;
                    }
                }

                const slots = data.timeSlots.map(slot => {
                    const slotMin = this._timeToMinutes(slot.startTime);
                    const isPast = isToday && (slotMin < cutoff || slotMin < earliestMinutes);
                    const available = slot.available === true && !isPast;
                    const isUnavailable = !available && !isPast;
                    return {
                        startTime: slot.startTime,
                        label: slot.startTime,
                        available,
                        availableCount: slot.availableCount || 0,
                        isPast,
                        booked: isUnavailable
                    };
                });

                if (this.state.selectedTimeSlot) {
                    const restoredSlot = slots.find(slot => slot.available && this._timeToMinutes(slot.startTime) === this.state.selectedTimeSlot.startMinutes);
                    if (restoredSlot) {
                        this.state.selectedTimeSlot = {
                            startTime: restoredSlot.startTime,
                            label: restoredSlot.label,
                            startMinutes: this._timeToMinutes(restoredSlot.startTime)
                        };
                    } else {
                        this.state.selectedTimeSlot = null;
                        this.options.onTimeSelect('');
                    }
                }

                this._renderTimeSlots(slots, date);
                return;
            }
            this.state.selectedTimeSlot = null;
            this.options.onTimeSelect('');
            this._renderTimeSlots([], date);
        } catch (e) {
            if (requestId !== this._timeRequestId) return;
            console.warn('CheckoutCalendar: time-slots API failed', e);
            this.state.selectedTimeSlot = null;
            this.options.onTimeSelect('');
            this.dom.timeGrid.innerHTML = '<div class="co-no-slots"><i class="bi bi-wifi-off"></i>Could not check available times. Please try again.<br><button type="button" class="btn btn-outline-primary btn-sm mt-2" id="coRetryTimes">Try again</button></div>';
            document.getElementById('coRetryTimes')?.addEventListener('click', () => this.loadTimeSlots(date));
        }
    }

    _renderTimeSlots(slots, date) {
        const grid = this.dom.timeGrid;
        const availableSlots = slots.filter(slot => slot.available && !slot.isPast);
        if (!availableSlots.length) {
            grid.innerHTML = '<div class="co-no-slots"><i class="bi bi-calendar-x"></i>No start times left for this date. Choose another open date.</div>';
            this.dom.nextAction.hidden = true;
            return;
        }
        this._syncNextAction(date);
        let html = `<p class="co-time-count">${availableSlots.length} start time${availableSlots.length === 1 ? '' : 's'} available · Choose one below</p>`;

        availableSlots.forEach(slot => {
            let cls = 'co-time-slot';
            const selected = this.state.selectedTimeSlot?.startTime === slot.startTime;
            if (selected) cls += ' selected';
            const statusLabel = selected ? 'Selected' : 'Available';
            const displayTime = this._formatDisplayTime(slot.label);
            html += `<div class="${cls}" data-start="${slot.startTime}" data-label="${slot.label}" role="button" tabindex="0" aria-pressed="${selected}" aria-label="${displayTime}, ${statusLabel}">
                <div class="co-time-slot-label">${this._formatDisplayTime(slot.label)}</div>
                <span class="co-time-slot-status available">${statusLabel}</span>
            </div>`;
        });

        grid.innerHTML = html;

        grid.querySelectorAll('.co-time-slot[role="button"]').forEach(el => {
            el.addEventListener('click', () => {
                this.state.selectedTimeSlot = {
                    startTime: el.dataset.start,
                    label: el.dataset.label,
                    startMinutes: this._timeToMinutes(el.dataset.start)
                };
                this.render();
                this._renderTimeSlots(slots, date);
                this.options.onTimeSelect(el.dataset.label);
                this._syncNextAction(date);
                setTimeout(() => this.dom.nextAction.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
            });
            el.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    el.click();
                }
            });
        });
    }

    _formatDisplayTime(value) {
        const minutes = this._timeToMinutes(value);
        if (!Number.isFinite(minutes)) return value;
        const hour = Math.floor(minutes / 60);
        const minute = String(minutes % 60).padStart(2, '0');
        const period = hour >= 12 ? 'PM' : 'AM';
        const displayHour = hour % 12 || 12;
        return `${displayHour}:${minute} ${period}`;
    }

    _timeToMinutes(t) {
        const match = String(t || '').trim().match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
        if (!match) return NaN;
        let hour = Number(match[1]);
        const minute = Number(match[2]);
        const period = String(match[3] || '').toUpperCase();
        if (period) {
            hour %= 12;
            if (period === 'PM') hour += 12;
        }
        return hour * 60 + minute;
    }

    _minutesToTime(m) {
        const h = Math.floor(m / 60);
        const min = m % 60;
        return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
    }

    async validateSelectedSlot(dateValue, timeValue) {
        const selectedDate = dateValue
            ? new Date(`${String(dateValue).slice(0, 10)}T00:00:00`)
            : this.state.selectedDate;
        const selectedTime = timeValue || this.state.selectedTimeSlot?.startTime;
        if (!selectedDate || Number.isNaN(selectedDate.getTime()) || !selectedTime) return false;
        const dateStr = this._formatKey(selectedDate);
        const selectedMinutes = this._timeToMinutes(selectedTime);
        if (!Number.isFinite(selectedMinutes)) return false;

        try {
            const params = new URLSearchParams({
                date: dateStr,
                duration: this.state.duration,
                quantity: this.state.quantity,
                travelTime: this.state.travelTime
            });
            const response = await fetch(`/api/schedule/time-slots?${params.toString()}`, {
                cache: 'no-store',
                headers: { Accept: 'application/json' }
            });
            if (!response.ok) throw new Error('Schedule validation failed');
            const data = await response.json();
            const stillAvailable = Array.isArray(data.timeSlots) && data.timeSlots.some(slot =>
                slot.available === true && !slot.isPast && this._timeToMinutes(slot.startTime) === selectedMinutes
            );
            if (stillAvailable) {
                this.state.selectedDate = selectedDate;
                this.state.selectedTimeSlot = {
                    startTime: selectedTime,
                    label: selectedTime,
                    startMinutes: selectedMinutes
                };
                return true;
            }
        } catch (error) {
            console.warn('CheckoutCalendar: selected-slot validation failed', error);
        }

        this.state.selectedTimeSlot = null;
        this.options.onTimeSelect('');
        this.state.selectedDate = selectedDate;
        await this.loadTimeSlots(selectedDate);
        return false;
    }

    clear() {
        this.state.selectedDate = null;
        this.state.selectedTimeSlot = null;
        if (this.dom.timeSection) this.dom.timeSection.style.display = 'none';
        this.dom.nextAction.hidden = true;
        this.render();
    }
}
