(function(){
  'use strict';

  var $ = function(id) { return document.getElementById(id); };

  // ── KPI Modal ──
  var kpiModalOverlay = $('kpiModalOverlay');
  var kpiModalTitle = $('kpiModalTitle');
  var kpiModalSubtitle = $('kpiModalSubtitle');
  var kpiModalIcon = $('kpiModalIcon');
  var kpiModalBody = $('kpiModalBody');
  var kpiModalClose = $('kpiModalClose');

  function fmtM(v) { return fmtMoney(v, _dashData.revenueCurrency); }
  function fmtPct(v, total) { return total > 0 ? Math.round((v / total) * 100) : 0; }
  function renderMini(val, lbl) { return '<div class="kpi-modal-mini"><div class="kpi-modal-mini-val">' + val + '</div><div class="kpi-modal-mini-lbl">' + lbl + '</div></div>'; }
  function renderStat(label, value, icon) { return '<div class="kpi-modal-stat"><span class="kpi-modal-stat-label"><i class="bi ' + (icon || 'bi-circle-fill') + '"></i>' + label + '</span><span class="kpi-modal-stat-value">' + value + '</span></div>'; }
  function renderSection(title, cls, content) { return '<div class="kpi-modal-section"><div class="kpi-modal-section-title ' + (cls || '') + '">' + title + '</div>' + content + '</div>'; }
  function renderPill(label, value) { return '<div class="kpi-modal-pill"><span class="kpi-modal-pill-lbl">' + label + '</span><span class="kpi-modal-pill-val">' + value + '</span></div>'; }
  function renderProgress(label, val, total, color) {
    var pct = total > 0 ? Math.round((val / total) * 100) : 0;
    var barColor = color || '#2563eb';
    return '<div class="kpi-modal-progress-row" style="gap:10px;"><span class="kpi-modal-progress-label" style="min-width:120px;max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + label + '">' + label + '</span><div class="kpi-modal-progress-track" style="flex:1;"><div class="kpi-modal-progress-fill" style="width:' + pct + '%;background:' + barColor + '"></div></div><span class="kpi-modal-progress-val" style="min-width:28px;text-align:right;">' + val + '</span></div>';
  }
  var chartDataLabelPlugin = {
    id: 'chartDataLabels',
    afterDatasetsDraw: function(chart) {
      var h = chart.canvas.height || chart.canvas.offsetHeight || 0;
      if (h < 80) return;
      var ctx = chart.ctx;
      chart.data.datasets.forEach(function(ds, di) {
        var meta = chart.getDatasetMeta(di);
        meta.data.forEach(function(el, idx) {
          var val = ds.data[idx];
          if (val == null || val === 0) return;
          var pos = el.tooltipPosition();
          ctx.save();
          ctx.font = '700 10px Inter, sans-serif';
          ctx.fillStyle = '#0f172a';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          if (chart.config.type === 'pie' || chart.config.type === 'doughnut') {
            ctx.fillStyle = '#fff';
            ctx.font = '700 11px Inter, sans-serif';
            ctx.textBaseline = 'middle';
            var total = ds.data.reduce(function(s,v){ return s + (v||0); }, 0);
            var pct = total > 0 ? Math.round((val / total) * 100) : 0;
            if (pct >= 5) ctx.fillText(pct + '%', pos.x, pos.y);
          } else {
            ctx.fillText(val, pos.x, pos.y - 4);
          }
          ctx.restore();
        });
      });
    }
  };
  if (typeof Chart !== 'undefined' && !Chart.registry.plugins.get('chartDataLabels')) {
    Chart.register(chartDataLabelPlugin);
  }
  function barChartOptions(labelFn) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 900, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          padding: 14,
          cornerRadius: 10,
          titleFont: { size: 12, weight: '700' },
          bodyFont: { size: 11, weight: '600' },
          displayColors: true,
          boxPadding: 6,
          callbacks: {
            title: function(items) { return items[0].label; },
            label: labelFn || function(c) { return c.label + ': ' + c.raw; }
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 10, weight: '600' }, maxRotation: 45, minRotation: 0 } },
        y: { beginAtZero: true, grid: { color: '#f1f5f9', borderDash: [5,5] }, ticks: { color: '#94a3b8', font: { size: 10 } }, border: { display: false } }
      }
    };
  }
  function doughnutChartOptions(labelFn) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '55%',
      animation: { duration: 900, easing: 'easeOutQuart', animateRotate: true, animateScale: true },
      plugins: {
        legend: {
          display: true, position: 'bottom',
          labels: {
            usePointStyle: true, boxWidth: 9, padding: 12,
            font: { size: 10, weight: '600' }, color: '#475569',
            generateLabels: function(chart) {
              var data = chart.data;
              var total = data.datasets[0].data.reduce(function(s,v){ return s + (v||0); }, 0);
              return data.labels.map(function(label, i) {
                var val = data.datasets[0].data[i] || 0;
                var pct = total > 0 ? Math.round((val / total) * 100) : 0;
                return {
                  text: label + ' (' + pct + '%)',
                  fillStyle: data.datasets[0].backgroundColor[i],
                  strokeStyle: data.datasets[0].backgroundColor[i],
                  pointStyle: 'circle',
                  hidden: false, index: i
                };
              });
            }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          padding: 14, cornerRadius: 10,
          titleFont: { size: 12, weight: '700' },
          bodyFont: { size: 11, weight: '600' },
          displayColors: true, boxPadding: 6,
          callbacks: {
            title: function(items) { return items[0].label; },
            label: labelFn || function(c) {
              var total = c.dataset.data.reduce(function(s,v){ return s + (v||0); }, 0);
              var pct = total > 0 ? Math.round((c.raw / total) * 100) : 0;
              return c.raw + ' (' + pct + '%)';
            }
          }
        }
      }
    };
  }
  function pieChartOptions(labelFn) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 900, easing: 'easeOutQuart', animateRotate: true, animateScale: true },
      plugins: {
        legend: {
          display: true, position: 'bottom',
          labels: {
            usePointStyle: true, boxWidth: 9, padding: 12,
            font: { size: 10, weight: '600' }, color: '#475569',
            generateLabels: function(chart) {
              var data = chart.data;
              var total = data.datasets[0].data.reduce(function(s,v){ return s + (v||0); }, 0);
              return data.labels.map(function(label, i) {
                var val = data.datasets[0].data[i] || 0;
                var pct = total > 0 ? Math.round((val / total) * 100) : 0;
                return {
                  text: label + ' (' + pct + '%)',
                  fillStyle: data.datasets[0].backgroundColor[i],
                  strokeStyle: data.datasets[0].backgroundColor[i],
                  pointStyle: 'circle',
                  hidden: false, index: i
                };
              });
            }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          padding: 14, cornerRadius: 10,
          titleFont: { size: 12, weight: '700' },
          bodyFont: { size: 11, weight: '600' },
          displayColors: true, boxPadding: 6,
          callbacks: {
            title: function(items) { return items[0].label; },
            label: labelFn || function(c) {
              var total = c.dataset.data.reduce(function(s,v){ return s + (v||0); }, 0);
              var pct = total > 0 ? Math.round((c.raw / total) * 100) : 0;
              return c.raw + ' (' + pct + '%)';
            }
          }
        }
      }
    };
  }
  function buildModalContent(type, data) {
    var pipe = _dashData.pipeline || {};
    var sd = _dashData.serviceDistribution || [];
    var rt = _dashData.ratingDistribution || {};
    var html = '';

    if (type === 'bookings') {
      var totalPipe = (pipe.pending||0) + (pipe.confirmed||0) + (pipe.scheduled||0) + (pipe.onTheWay||0) + (pipe.arrived||0) + (pipe.inProgress||0) + (pipe.completed||0);
      html += renderSection('7-Day Summary', 'blue',
        renderMini(data.today, 'Today') +
        renderMini(data.weekTotal || 0, 'This Week') +
        renderMini(_dashData.totalBookingsAllTime || 0, 'All-Time')
      );
      html += renderSection('Booking Pipeline', 'blue',
        renderProgress('Pending', pipe.pending || 0, totalPipe, '#2563eb') +
        renderProgress('Confirmed', pipe.confirmed || 0, totalPipe, '#3b82f6') +
        renderProgress('Scheduled', pipe.scheduled || 0, totalPipe, '#06b6d4') +
        renderProgress('On The Way', pipe.onTheWay || 0, totalPipe, '#f59e0b') +
        renderProgress('In Progress', pipe.inProgress || 0, totalPipe, '#8b5cf6') +
        renderProgress('Completed', pipe.completed || 0, totalPipe, '#10b981')
      );
      html += renderSection('Performance Metrics', 'blue',
        renderStat('Completed Today', _dashData.completedToday || 0, 'bi-check-circle') +
        renderStat('Cancelled', pipe.cancelled || 0, 'bi-x-circle') +
        renderStat('Completion Rate', (_dashData.completionRate || 0) + '%', 'bi-graph-up') +
        renderStat('Active Projects', _dashData.activeProjects || 0, 'bi-kanban')
      );
    }
    if (type === 'pending') {
      var pendTotal = (_dashData.pendingReview || 0) + (_dashData.completedToday || 0) + (_dashData.pendingPayments || 0);
      html += renderSection('Financial Snapshot', 'amber',
        renderMini(fmtM(_dashData.pendingPayments || 0), 'Pending Pay') +
        renderMini(fmtM(_dashData.monthlyRevenue || 0), 'Monthly Rev') +
        renderMini(fmtM(_dashData.lastMonthRevenue || 0), 'Last Month')
      );
      html += renderSection('Payment & Expense Flow', 'amber',
        renderStat('Pending Payments', fmtM(_dashData.pendingPayments || 0), 'bi-credit-card') +
        renderStat('Monthly Revenue', fmtM(_dashData.monthlyRevenue || 0), 'bi-cash-stack') +
        renderStat('Last Month Revenue', fmtM(_dashData.lastMonthRevenue || 0), 'bi-graph-up-arrow') +
        renderStat('Monthly Expenses', fmtM(_dashData.monthlyExpenses || 0), 'bi-receipt') +
        renderStat('Pending Expenses', _dashData.pendingExpenses || 0, 'bi-clock-history') +
        renderStat('Pending Exp. Total', fmtM(_dashData.pendingExpensesTotal || 0), 'bi-exclamation-circle') +
        renderStat('Profit Margin', (_dashData.profitMargin || 0) + '%', 'bi-pie-chart')
      );
    }
    if (type === 'awaiting') {
      html += renderSection('Assignment Overview', 'purple',
        renderMini(_dashData.awaitingAssignment || 0, 'Unassigned') +
        renderMini(_dashData.totalTechnicians || 0, 'Total Techs') +
        renderMini(_dashData.availableTechnicians || 0, 'Available')
      );
      html += renderSection('Job Readiness Pipeline', 'purple',
        renderProgress('Confirmed (No Tech)', _dashData.awaitingAssignment || 0, _dashData.totalBookingsAllTime || 1, '#8b5cf6') +
        renderProgress('Scheduled', pipe.scheduled || 0, _dashData.totalBookingsAllTime || 1, '#06b6d4') +
        renderProgress('On The Way', pipe.onTheWay || 0, _dashData.totalBookingsAllTime || 1, '#f59e0b') +
        renderProgress('Arrived', pipe.arrived || 0, _dashData.totalBookingsAllTime || 1, '#d946ef')
      );
      html += renderSection('Technician Capacity', 'purple',
        renderStat('Total Technicians', _dashData.totalTechnicians || 0, 'bi-people') +
        renderStat('Available', _dashData.availableTechnicians || 0, 'bi-person-check') +
        renderStat('Busy / Assigned', _dashData.busyTechnicians || 0, 'bi-person-workspace') +
        renderStat('Absent / Offline', _dashData.absentTechnicians || 0, 'bi-person-x')
      );
    }
    if (type === 'active') {
      var activeTotal = (pipe.onTheWay || 0) + (pipe.arrived || 0) + (pipe.inProgress || 0);
      html += renderSection('Live Activity', 'green',
        renderMini(pipe.onTheWay || 0, 'On The Way') +
        renderMini(pipe.arrived || 0, 'Arrived') +
        renderMini(pipe.inProgress || 0, 'In Progress')
      );
      html += renderSection('Service Status Breakdown', 'green',
        renderProgress('On The Way', pipe.onTheWay || 0, activeTotal || 1, '#f59e0b') +
        renderProgress('Arrived', pipe.arrived || 0, activeTotal || 1, '#d946ef') +
        renderProgress('In Progress', pipe.inProgress || 0, activeTotal || 1, '#8b5cf6') +
        renderProgress('Completed Today', _dashData.completedToday || 0, activeTotal || 1, '#10b981')
      );
      html += renderSection('Service Type Distribution', 'green', (function() {
        var s = '';
        if (!sd.length) return renderStat('No data', '--', 'bi-info-circle');
        sd.slice(0, 6).forEach(function(it) {
          s += renderPill(it.name || 'Other', it.count || 0);
        });
        return '<div class="kpi-modal-pill-row">' + s + '</div>';
      })());
    }
    if (type === 'techs') {
      html += renderSection('Workforce Overview', 'cyan',
        renderMini(_dashData.availableTechnicians || 0, 'Available') +
        renderMini(_dashData.busyTechnicians || 0, 'Busy') +
        renderMini(_dashData.totalTechnicians || 0, 'Total')
      );
      html += renderSection('Technician Allocation', 'cyan',
        renderProgress('Available', _dashData.availableTechnicians || 0, _dashData.totalTechnicians || 1, '#10b981') +
        renderProgress('Busy / Assigned', _dashData.busyTechnicians || 0, _dashData.totalTechnicians || 1, '#f59e0b') +
        renderProgress('Absent / Offline', _dashData.absentTechnicians || 0, _dashData.totalTechnicians || 1, '#64748b')
      );
      html += renderSection('Customer & Quality Metrics', 'cyan',
        renderStat('Total Customers', _dashData.totalCustomers || 0, 'bi-people') +
        renderStat('New This Month', '+' + (_dashData.newCustomersThisMonth || 0), 'bi-person-plus') +
        renderStat('VIP Customers', _dashData.vipCustomers || 0, 'bi-star') +
        renderStat('Avg Rating', (_dashData.avgRating || '--') + ' ★', 'bi-heart')
      );
    }
    if (type === 'revenue') {
      var profit = Math.max(0, (_dashData.monthlyRevenue || 0) - (_dashData.monthlyExpenses || 0));
      html += renderSection('Revenue Breakdown', 'red',
        renderMini(fmtM(_dashData.monthlyRevenue || 0), 'Monthly') +
        renderMini(fmtM(_dashData.lastMonthRevenue || 0), 'Last Month') +
        renderMini(fmtM(_dashData.revenueToday || 0), 'Today')
      );
      html += renderSection('Profitability', 'red',
        renderStat('Monthly Revenue', fmtM(_dashData.monthlyRevenue || 0), 'bi-cash') +
        renderStat('Monthly Expenses', fmtM(_dashData.monthlyExpenses || 0), 'bi-receipt') +
        renderStat('Net Profit', fmtM(profit), 'bi-currency-dollar') +
        renderStat('Profit Margin', (_dashData.profitMargin || 0) + '%', 'bi-percent') +
        renderStat('Pending Payments', fmtM(_dashData.pendingPayments || 0), 'bi-credit-card') +
        renderStat('Pending Expenses', fmtM(_dashData.pendingExpensesTotal || 0), 'bi-clock')
      );
      html += renderSection('7-Day Revenue Trend', 'red',
        '<div class="kpi-modal-chart" style="height:150px;margin-top:8px;"><canvas id="kpiModalRevenueChart"></canvas></div>'
      );
    }
    return html;
  }

  var dashboardCardConfig = {};

  function buildDashboardCardModalContent(type) {
    var cfg = dashboardCardConfig[type];
    return (cfg && cfg.getContent ? cfg.getContent() : '<div class="dash-empty">No details available</div>');
  }

  function openDashboardCard(type) {
    var cfg = dashboardCardConfig[type];
    if (!cfg) return;
    openKpiModal(type, cfg.title, cfg.subtitle, cfg.iconClass, cfg.color, cfg.getData());
  }

  var DASHBOARD_CARD_TYPES = ['bookingsTrend','serviceDistribution','technicianStatus','todaySchedule','healthBanner','bookingPipeline','financialOverview','customerSatisfaction','notifications','customerInsights','largeScaleProjects','teamPerformance','expenseSummary','airconInventory','topAirconProducts'];

  dashboardCardConfig.bookingsTrend = {
    title: 'Bookings Trend',
    subtitle: 'Detailed 7-day booking analytics',
    iconClass: 'bi-graph-up-arrow',
    color: '#2563eb',
    getData: function() {
      var trend = _dashData.trend7 || [];
      var labels = trend.map(function(t){ return t.date; });
      var counts = trend.map(function(t){ return t.count; });
      if (!labels.length) { labels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']; counts = [0,0,0,0,0,0,0]; }
      var total7 = counts.reduce(function(s,c){ return s + c; }, 0);
      var max7 = Math.max.apply(Math, counts.concat([0]));
      return {
        chart: { labels: labels, data: counts },
        chartTitle: '7-Day Bookings',
        minis: renderMini(total7, 'Total 7-Day') + renderMini(_dashData.totalBookingsToday || 0, 'Today') + renderMini(max7, 'Peak Day'),
        chartLabel: function(c){ return c.raw + ' bookings'; }
      };
    },
    getContent: function() {
      var pipe = _dashData.pipeline || {};
      var totalPipe = (pipe.pending||0)+(pipe.confirmed||0)+(pipe.scheduled||0)+(pipe.onTheWay||0)+(pipe.arrived||0)+(pipe.inProgress||0)+(pipe.completed||0);
      return renderSection('Booking Summary', 'blue',
        renderStat('Today', _dashData.totalBookingsToday || 0, 'bi-calendar-check') +
        renderStat('This Week', _dashData.trend7.reduce(function(s,t){ return s + (t.count||0); },0) || 0, 'bi-calendar-week') +
        renderStat('All-Time', _dashData.totalBookingsAllTime || 0, 'bi-graph-up') +
        renderStat('Completed Today', _dashData.completedToday || 0, 'bi-check-circle')
      ) +
      renderSection('Booking Pipeline', 'blue',
        renderProgress('Pending', pipe.pending||0, totalPipe||1, '#f59e0b') +
        renderProgress('Confirmed', pipe.confirmed||0, totalPipe||1, '#3b82f6') +
        renderProgress('Scheduled', pipe.scheduled||0, totalPipe||1, '#8b5cf6') +
        renderProgress('On The Way', pipe.onTheWay||0, totalPipe||1, '#f97316') +
        renderProgress('In Progress', pipe.inProgress||0, totalPipe||1, '#10b981') +
        renderProgress('Completed', pipe.completed||0, totalPipe||1, '#64748b')
      );
    }
  };

  dashboardCardConfig.serviceDistribution = {
    title: 'Service Distribution',
    subtitle: 'All-time service type analytics',
    iconClass: 'bi-pie-chart-fill',
    color: '#8b5cf6',
    getData: function() {
      var svc = _dashData.serviceDistribution || [];
      if (!svc.length) svc = [{ name: 'No Data', count: 1 }];
      var colors = ['#3b82f6','#10b981','#f59e0b','#ef4444','#06b6d4','#64748b','#f97316','#ec4899'];
      var total = svc.reduce(function(s,x){ return s + (x.count||0); }, 0);
      var sorted = svc.slice().sort(function(a,b){ return (b.count||0) - (a.count||0); });
      var pieColors = svc.map(function(_,i){ return colors[i % colors.length]; });
      return {
        chart: {
          labels: svc.map(function(s){ return s.name || 'Other'; }),
          data: svc.map(function(s){ return s.count || 0; }),
          datasets: [{
            data: svc.map(function(s){ return s.count || 0; }),
            backgroundColor: pieColors,
            borderWidth: 2,
            borderColor: '#fff',
            hoverOffset: 6
          }]
        },
        chartType: 'pie',
        chartTitle: 'Service Mix',
        chartOptions: pieChartOptions(function(c){ return (c.label || '') + ': ' + c.raw + ' bookings (' + (total > 0 ? Math.round((c.raw/total)*100) : 0) + '%)'; }),
        minis: renderMini(total, 'Bookings') + renderMini(sorted[0] ? sorted[0].name : '--', 'Top') + renderMini(svc.length, 'Services')
      };
    },
    getContent: function() {
      var svc = _dashData.serviceDistribution || [];
      var total = svc.reduce(function(s,x){ return s + (x.count||0); }, 0);
      if (!svc.length) return renderSection('Breakdown', 'purple', '<div class="dash-empty">No service data available</div>');
      var colors = ['#3b82f6','#10b981','#f59e0b','#ef4444','#06b6d4','#64748b','#f97316','#ec4899'];
      var sorted = svc.slice().sort(function(a,b){ return (b.count||0) - (a.count||0); });
      var top = sorted[0] || { count: 0 };
      var topPct = total > 0 ? Math.round((top.count / total) * 100) : 0;
      return renderSection('Service Share', 'purple',
        svc.slice(0,8).map(function(s, i) {
          var c = colors[i % colors.length];
          return renderProgress(s.name || 'Other', s.count || 0, total || 1, c);
        }).join('')
      ) +
      renderSection('Service Insights', 'purple',
        renderStat('Most Booked', (top.name || '--') + ' <span style="font-size:0.7rem;color:#94a3b8;">(' + topPct + '%)</span>', 'bi-trophy') +
        renderStat('Total Services', svc.length, 'bi-diagram-3') +
        renderStat('Total Bookings', total, 'bi-graph-up') +
        renderStat('Avg Bookings / Service', svc.length > 0 ? (total / svc.length).toFixed(1) : '0', 'bi-calculator')
      );
    }
  };

  dashboardCardConfig.technicianStatus = {
    title: 'Technician Status',
    subtitle: 'Workforce availability and assignments',
    iconClass: 'bi-people-fill',
    color: '#f59e0b',
    getData: function() {
      return { fullWidth: true };
    },
    getContent: function() {
      var total = _dashData.totalTechnicians || 0;
      var avail = _dashData.availableTechnicians || 0;
      var busy = _dashData.busyTechnicians || 0;
      var absent = _dashData.absentTechnicians || 0;
      var av = total > 0 ? Math.round((avail/total)*100) : 0;
      var bu = total > 0 ? Math.round((busy/total)*100) : 0;
      return renderSection('Availability', 'amber',
        renderProgress('Available', avail, total||1, '#10b981') +
        renderProgress('Busy / Assigned', busy, total||1, '#f59e0b') +
        renderProgress('Offline / Absent', absent, total||1, '#64748b')
      ) +
      renderSection('Workforce Metrics', 'amber',
        renderStat('Total Technicians', total, 'bi-people') +
        renderStat('Available Now', avail + ' <span style="font-size:0.75rem;color:#94a3b8;">(' + av + '%)</span>', 'bi-person-check') +
        renderStat('Busy / Assigned', busy + ' <span style="font-size:0.75rem;color:#94a3b8;">(' + bu + '%)</span>', 'bi-person-workspace') +
        renderStat('Offline / Absent', absent, 'bi-person-x')
      ) +
      (function() {
        var techs = _dashData.technicianList || [];
        if (!techs.length) return '';
        return renderSection('Technician Roster', 'amber',
          '<div style="display:flex;flex-direction:column;gap:6px;margin-top:8px;">' + techs.map(function(t) {
            var st = (t.status || 'offline').toLowerCase();
            var c = st === 'available' ? '#10b981' : st === 'busy' || st === 'assigned' ? '#f59e0b' : '#64748b';
            return '<div class="dash-list-row" style="padding:8px 12px;border-radius:10px;background:#f8fafc;border-left:3px solid ' + c + ';">' +
              '<span style="font-weight:700;color:#0f172a;font-size:0.8rem;">' + (t.name || t.username || 'Technician') + '</span>' +
              '<span style="font-size:0.65rem;padding:2px 8px;border-radius:999px;background:' + c + '20;color:' + c + ';">' + (t.status || 'Offline') + '</span>' +
              '</div>';
          }).join('') + '</div>'
        );
      })();
    }
  };

  dashboardCardConfig.todaySchedule = {
    title: "Today's Schedule",
    subtitle: 'Upcoming appointments and service visits',
    iconClass: 'bi-calendar3',
    color: '#3b82f6',
    getData: function() {
      var items = _dashData.todaySchedule || [];
      var upcoming = 0, active = 0, completed = 0;
      items.forEach(function(it) {
        var st = (it.status || '').toLowerCase();
        if (st === 'completed') completed++; else if (st === 'in-progress' || st === 'arrived' || st === 'on-the-way' || st === 'in_progress') active++; else upcoming++;
      });
      var counts = [upcoming, active, completed];
      if (counts.every(function(v){ return v === 0; })) counts = [1,0,0];
      var total = counts.reduce(function(s,v){ return s + v; }, 0);
      return {
        chart: {
          labels: ['Upcoming','Active','Completed'],
          data: counts,
          datasets: [{
            data: counts,
            backgroundColor: ['#3b82f6D0','#f59e0bD0','#10b981D0'],
            borderWidth: 0,
            borderRadius: 6,
            barThickness: 40,
            maxBarThickness: 60
          }]
        },
        chartType: 'bar',
        chartTitle: 'Today\'s Appointments',
        chartOptions: barChartOptions(function(c){ return (c.label || '') + ': ' + c.raw + ' (' + (total > 0 ? Math.round((c.raw/total)*100) : 0) + '%)'; }),
        minis: renderMini(upcoming, 'Upcoming') + renderMini(active, 'Active') + renderMini(completed, 'Done')
      };
    },
    getContent: function() {
      var items = _dashData.todaySchedule || [];
      var colors = {
        pending: '#f59e0b', confirmed: '#3b82f6', scheduled: '#3b82f6', 'on-the-way': '#f97316', arrived: '#10b981', 'in-progress': '#10b981', completed: '#64748b', cancelled: '#ef4444'
      };
      if (!items.length) return renderSection('Timeline', 'blue', '<div class="dash-empty">No upcoming appointments today</div>');
      return renderSection('Appointment Timeline', 'blue',
        '<div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">' + items.map(function(it) {
          var st = (it.status || '').toLowerCase();
          var c = colors[st] || '#f59e0b';
          return '<div class="dash-list-row" style="align-items:flex-start;padding:12px 14px;border-radius:10px;background:#f8fafc;border-left:3px solid ' + c + ';">' +
            '<div style="display:flex;flex-direction:column;gap:3px;flex:1;">' +
            '<span style="font-weight:700;color:#0f172a;font-size:0.85rem;">' + (it.customer || 'Customer') + '</span>' +
            '<span style="font-size:0.72rem;color:#64748b;">' + (it.service || 'Service') + ' · ' + (it.technician || 'Unassigned') + '</span>' +
            '</div>' +
            '<div style="text-align:right;min-width:70px;">' +
            '<div style="font-size:0.85rem;font-weight:800;color:#0f172a;">' + (it.time || '--:--') + '</div>' +
            '<span class="dash-list-badge" style="font-size:0.6rem;padding:2px 8px;border-radius:999px;background:' + c + '20;color:' + c + ';">' + (it.status || '') + '</span>' +
            '</div></div>';
        }).join('') + '</div>'
      );
    }
  };

  dashboardCardConfig.healthBanner = {
    title: 'Items Require Attention',
    subtitle: 'System health and action alerts',
    iconClass: 'bi-shield-check',
    color: '#10b981',
    getData: function() {
      return { fullWidth: true };
    },
    getContent: function() {
      var alerts = [
        { key: 'pendingReview', label: 'Pending Review', icon: 'bi-clock-history', color: '#f59e0b', count: _dashData.pendingReview || 0 },
        { key: 'awaitingAssignment', label: 'Awaiting Assignment', icon: 'bi-person-plus', color: '#8b5cf6', count: _dashData.awaitingAssignment || 0 },
        { key: 'pendingExpenses', label: 'Expense Approval', icon: 'bi-receipt', color: '#3b82f6', count: _dashData.pendingExpenses || 0 },
        { key: 'lowStockCount', label: 'Low / Out of Stock', icon: 'bi-exclamation-triangle', color: '#ef4444', count: _dashData.lowStockCount || 0 }
      ];
      var total = alerts.reduce(function(s,a){ return s + a.count; }, 0);
      if (!total) return renderSection('Status', 'green', '<div class="dash-empty" style="text-align:center;padding:12px 0;"><span class="dash-chip success"><i class="bi bi-check-circle"></i> All systems running smoothly — no action required</span></div>');
      return renderSection('Alert Breakdown', 'green',
        alerts.map(function(a) {
          return renderProgress(a.label, a.count, total || 1, a.color);
        }).join('')
      ) +
      renderSection('Recommended Actions', 'green',
        alerts.filter(function(a){ return a.count > 0; }).map(function(a) {
          return '<div class="kpi-modal-stat" style="border-left:3px solid ' + a.color + ';"><span class="kpi-modal-stat-label"><i class="bi ' + a.icon + '" style="color:' + a.color + ';"></i>' + a.count + ' ' + a.label.toLowerCase() + '</span><span class="kpi-modal-stat-value" style="color:' + a.color + ';">!</span></div>';
        }).join('')
      );
    }
  };

  dashboardCardConfig.bookingPipeline = {
    title: 'Booking Pipeline',
    subtitle: 'All stages from pending to completed',
    iconClass: 'bi-funnel-fill',
    color: '#06b6d4',
    getData: function() {
      var p = _dashData.pipeline || {};
      var stages = [
        { label: 'Pending', count: p.pending || 0, color: '#f59e0b' },
        { label: 'Confirmed', count: p.confirmed || 0, color: '#3b82f6' },
        { label: 'Scheduled', count: p.scheduled || 0, color: '#8b5cf6' },
        { label: 'On The Way', count: p.onTheWay || 0, color: '#f97316' },
        { label: 'Arrived', count: p.arrived || 0, color: '#06b6d4' },
        { label: 'In Progress', count: p.inProgress || 0, color: '#10b981' },
        { label: 'Completed', count: p.completed || 0, color: '#64748b' },
        { label: 'Cancelled', count: p.cancelled || 0, color: '#ef4444' }
      ];
      var total = stages.reduce(function(s, st){ return s + st.count; }, 0);
      var labels = stages.map(function(st){ return st.label; });
      var data = stages.map(function(st){ return st.count; });
      var colors = stages.map(function(st){ return st.color + 'D0'; });
      return {
        chart: {
          labels: labels,
          data: data,
          datasets: [{
            data: data,
            backgroundColor: colors,
            borderWidth: 0,
            borderRadius: 5,
            barThickness: 'flex',
            maxBarThickness: 24
          }]
        },
        chartType: 'bar',
        chartTitle: 'Pipeline Stages',
        chartOptions: barChartOptions(function(c){ return (c.label || '') + ': ' + c.raw + ' (' + (total > 0 ? Math.round((c.raw/total)*100) : 0) + '%)'; }),
        minis: renderMini(total, 'Total') + renderMini(p.inProgress || 0, 'In Progress') + renderMini(p.completed || 0, 'Completed')
      };
    },
    getContent: function() {
      var p = _dashData.pipeline || {};
      var stages = [
        { key: 'pending', label: 'Pending', color: '#f59e0b', count: p.pending || 0 },
        { key: 'confirmed', label: 'Confirmed', color: '#3b82f6', count: p.confirmed || 0 },
        { key: 'scheduled', label: 'Scheduled', color: '#8b5cf6', count: p.scheduled || 0 },
        { key: 'onTheWay', label: 'On The Way', color: '#f97316', count: p.onTheWay || 0 },
        { key: 'arrived', label: 'Arrived', color: '#06b6d4', count: p.arrived || 0 },
        { key: 'inProgress', label: 'In Progress', color: '#10b981', count: p.inProgress || 0 },
        { key: 'completed', label: 'Completed', color: '#64748b', count: p.completed || 0 },
        { key: 'cancelled', label: 'Cancelled', color: '#ef4444', count: p.cancelled || 0 }
      ];
      var total = stages.reduce(function(s, st){ return s + st.count; }, 0);
      return renderSection('Pipeline Overview', 'cyan',
        renderStat('Total Bookings', total, 'bi-funnel') +
        renderStat('In Progress', p.inProgress || 0, 'bi-arrow-repeat') +
        renderStat('Completed', p.completed || 0, 'bi-check-circle')
      ) +
      renderSection('Pipeline Stages', 'cyan',
        stages.map(function(st) {
          return renderProgress(st.label, st.count, total || 1, st.color);
        }).join('')
      );
    }
  };

  dashboardCardConfig.financialOverview = {
    title: 'Financial Overview',
    subtitle: 'Revenue, expenses, and profitability',
    iconClass: 'bi-cash-stack',
    color: '#059669',
    getData: function() {
      var r = _dashData.revenueTrend7 || [];
      var labels = r.map(function(x){ return x.date; });
      var amounts = r.map(function(x){ return x.amount; });
      if (!labels.length) { labels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']; amounts = [0,0,0,0,0,0,0]; }
      var rev7 = amounts.reduce(function(s,a){ return s + a; }, 0);
      return {
        chart: { labels: labels, data: amounts },
        chartTitle: '7-Day Revenue',
        minis: renderMini(fmtM(_dashData.revenueToday || 0), 'Today') + renderMini(fmtM(_dashData.monthlyRevenue || 0), 'Month') + renderMini(fmtM(rev7), '7-Day'),
        chartLabel: function(c){ return '₱' + c.raw.toLocaleString(); }
      };
    },
    getContent: function() {
      var cur = _dashData.revenueCurrency || 'PHP';
      var profit = Math.max(0, (_dashData.monthlyRevenue || 0) - (_dashData.monthlyExpenses || 0));
      var marginColor = (_dashData.profitMargin || 0) >= 20 ? '#059669' : '#d97706';
      return renderSection('Revenue', 'green',
        renderStat('Today', fmtM(_dashData.revenueToday || 0, cur), 'bi-calendar-day') +
        renderStat('Monthly', fmtM(_dashData.monthlyRevenue || 0, cur), 'bi-calendar-month') +
        renderStat('Last Month', fmtM(_dashData.lastMonthRevenue || 0, cur), 'bi-calendar2-minus') +
        renderStat('Pending Payments', fmtM(_dashData.pendingPayments || 0, cur), 'bi-hourglass-split')
      ) +
      renderSection('Profitability', 'green',
        renderStat('Monthly Expenses', fmtM(_dashData.monthlyExpenses || 0, cur), 'bi-receipt') +
        renderStat('Net Profit', fmtM(profit, cur), 'bi-currency-dollar') +
        renderStat('Profit Margin', (_dashData.profitMargin || 0) + '%', 'bi-pie-chart')
      );
    }
  };

  dashboardCardConfig.customerSatisfaction = {
    title: 'Customer Satisfaction',
    subtitle: 'Ratings, reviews and loyalty analytics',
    iconClass: 'bi-star-fill',
    color: '#f59e0b',
    getData: function() {
      var dist = _dashData.ratingDistribution || {};
      var labels = ['5★','4★','3★','2★','1★'];
      var data = [dist[5]||0, dist[4]||0, dist[3]||0, dist[2]||0, dist[1]||0];
      var colors = ['#10b981','#84cc16','#f59e0b','#f97316','#ef4444'];
      var total = data.reduce(function(s,v){ return s + v; }, 0);
      if (!total) { labels = ['No Data']; data = [1]; colors = ['#e2e8f0']; }
      return {
        chart: { labels: labels, data: data, datasets: [{ data: data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff', hoverOffset: 6 }] },
        chartType: 'pie',
        chartTitle: 'Rating Mix',
        chartOptions: pieChartOptions(function(c){ return c.label + ': ' + c.raw + ' reviews'; }),
        minis: renderMini((_dashData.avgRating || '--') + '★', 'Avg') + renderMini(total, 'Reviews') + renderMini((dist[5]||0), '5★')
      };
    },
    getContent: function() {
      var dist = _dashData.ratingDistribution || {};
      var totalR = _dashData.totalRatings || 0;
      var avg = _dashData.avgRating || '--';
      var max = Math.max(dist[5]||0, dist[4]||0, dist[3]||0, dist[2]||0, dist[1]||0, 1);
      var fivePct = totalR > 0 ? Math.round(((dist[5]||0) / totalR) * 100) : 0;
      var onePct = totalR > 0 ? Math.round(((dist[1]||0) / totalR) * 100) : 0;
      var satisfaction = totalR > 0 ? Math.round((((dist[5]||0) + (dist[4]||0)) / totalR) * 100) : 0;
      var colors = { 5: 'f5', 4: 'f4', 3: 'f3', 2: 'f2', 1: 'f1' };
      var html = renderSection('Rating Summary', 'amber',
        renderStat('Average Rating', avg + ' ★ <span style="font-size:0.7rem;color:#94a3b8;">(' + totalR + ' reviews)</span>', 'bi-star') +
        renderStat('Satisfaction Rate', satisfaction + '%', 'bi-emoji-smile') +
        renderStat('5-Star Reviews', (dist[5]||0) + ' <span style="font-size:0.7rem;color:#94a3b8;">(' + fivePct + '%)</span>', 'bi-hand-thumbs-up') +
        renderStat('1-Star Reviews', (dist[1]||0) + ' <span style="font-size:0.7rem;color:#94a3b8;">(' + onePct + '%)</span>', 'bi-hand-thumbs-down')
      );
      var distHtml = '<div style="display:flex;flex-direction:column;gap:5px;margin-top:8px;">';
      for (var r = 5; r >= 1; r--) {
        var cnt = dist[r] || 0;
        var pct = max > 0 ? Math.round((cnt / max) * 100) : 0;
        var share = totalR > 0 ? Math.round((cnt / totalR) * 100) : 0;
        distHtml += '<div class="rating-dist-row"><span class="rating-dist-label">' + r + '<i class="bi bi-star-fill"></i></span><div class="rating-dist-track"><div class="rating-dist-fill ' + colors[r] + '" style="width:' + pct + '%;"></div></div><span class="rating-dist-count">' + cnt + '</span><span style="width:34px;text-align:right;font-size:0.65rem;color:#94a3b8;font-weight:700;">' + share + '%</span></div>';
      }
      distHtml += '</div>';
      distHtml += '<div class="rating-summary-row" style="margin-top:10px;">' +
        '<div class="rating-summary-chip"><div class="rating-summary-chip-val">' + fivePct + '%</div><div class="rating-summary-chip-lbl">5-Star</div></div>' +
        '<div class="rating-summary-chip"><div class="rating-summary-chip-val">' + (dist[4]||0) + '</div><div class="rating-summary-chip-lbl">4-Star</div></div>' +
        '<div class="rating-summary-chip"><div class="rating-summary-chip-val">' + onePct + '%</div><div class="rating-summary-chip-lbl">1-Star</div></div>' +
        '</div>';
      html += renderSection('Rating Distribution', 'amber', distHtml);
      return html;
    }
  };

  dashboardCardConfig.notifications = {
    title: 'Notifications',
    subtitle: 'Recent alerts and reminders',
    iconClass: 'bi-bell-fill',
    color: '#f59e0b',
    getData: function() {
      return { fullWidth: true };
    },
    getContent: function() {
      var notes = (_dashData.notifications || []).slice();
      var lowItems = _dashData.lowStockItems || [];
      lowItems.slice(0, 5).forEach(function(it) {
        notes.push({ type: 'danger', icon: 'bi-exclamation-triangle-fill', message: 'Low stock: ' + (it.name || it.title || 'Item') + ' (' + (it.quantity != null ? it.quantity : it.stock != null ? it.stock : 0) + ' left)' });
      });
      if (!notes.length) return renderSection('Alerts', 'amber', '<div class="dash-empty">No notifications</div>');
      var total = notes.length;
      var danger = notes.filter(function(n){ return n.type === 'danger'; }).length;
      var warning = notes.filter(function(n){ return n.type === 'warning'; }).length;
      return renderSection('Alert Summary', 'amber',
        renderProgress('Critical', danger, total || 1, '#ef4444') +
        renderProgress('Warning', warning, total || 1, '#f59e0b') +
        renderProgress('Information', total - danger - warning, total || 1, '#3b82f6')
      ) +
      renderSection('All Alerts', 'amber',
        '<div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">' + notes.map(function(n) {
          var bg = n.type === 'danger' ? 'rgba(239,68,68,0.08)' : n.type === 'warning' ? 'rgba(245,158,11,0.08)' : 'rgba(59,130,246,0.08)';
          var fg = n.type === 'danger' ? '#dc2626' : n.type === 'warning' ? '#d97706' : '#2563eb';
          var border = n.type === 'danger' ? '#ef4444' : n.type === 'warning' ? '#f59e0b' : '#3b82f6';
          return '<div class="notif-item" style="border-radius:10px;padding:10px 12px;background:' + bg + ';border-left:3px solid ' + border + ';">' +
            '<div class="notif-icon" style="background:#fff;box-shadow:0 1px 4px rgba(0,0,0,0.05);color:' + fg + ';"><i class="bi ' + (n.icon || 'bi-info-circle') + '"></i></div>' +
            '<div style="flex:1;">' +
            '<div style="font-size:0.82rem;font-weight:600;color:#475569;">' + (n.message || '') + '</div>' +
            (n.time ? '<div style="font-size:0.65rem;color:#94a3b8;margin-top:2px;">' + n.time + '</div>' : '') +
            '</div></div>';
        }).join('') + '</div>'
      );
    }
  };

  dashboardCardConfig.customerInsights = {
    title: 'Customer Insights',
    subtitle: 'Customer growth and loyalty metrics',
    iconClass: 'bi-people-fill',
    color: '#3b82f6',
    getData: function() {
      var totalC = _dashData.totalCustomers || 0;
      var newC = _dashData.newCustomersThisMonth || 0;
      var vip = _dashData.vipCustomers || 0;
      var regular = Math.max(0, totalC - vip);
      var labels = ['Regular','VIP','New'];
      var data = [regular, vip, newC];
      var colors = ['#3b82f6','#f59e0b','#10b981'];
      if (data.every(function(v){ return v === 0; })) { data = [1,0,0]; }
      return {
        chart: { labels: labels, data: data, datasets: [{ data: data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff', hoverOffset: 6 }] },
        chartType: 'pie',
        chartTitle: 'Customer Mix',
        chartOptions: pieChartOptions(function(c){ return c.label + ': ' + c.raw + ' customers'; }),
        minis: renderMini(totalC, 'Total') + renderMini('+' + newC, 'New') + renderMini(vip, 'VIP')
      };
    },
    getContent: function() {
      var totalC = _dashData.totalCustomers || 0;
      var newC = _dashData.newCustomersThisMonth || 0;
      var vip = _dashData.vipCustomers || 0;
      var growthPct = totalC > 0 ? Math.round((newC / totalC) * 100) : 0;
      return renderSection('Customer Metrics', 'blue',
        renderStat('Total Customers', totalC, 'bi-people') +
        renderStat('New This Month', '+' + newC + ' <span style="font-size:0.75rem;color:#94a3b8;">(' + growthPct + '%)</span>', 'bi-person-plus') +
        renderStat('VIP Customers', vip, 'bi-star') +
        renderStat('Avg. Rating', (_dashData.avgRating || '--') + ' ★ <span style="font-size:0.75rem;color:#94a3b8;">(' + (_dashData.totalRatings || 0) + ')</span>', 'bi-heart')
      );
    }
  };

  dashboardCardConfig.largeScaleProjects = {
    title: 'Large-Scale Projects',
    subtitle: 'Project portfolio and completion rate',
    iconClass: 'bi-kanban-fill',
    color: '#8b5cf6',
    getData: function() {
      var total = _dashData.totalProjects || 0;
      var active = _dashData.activeProjects || 0;
      var completed = _dashData.completedProjects || 0;
      var labels = ['Active','Completed','Remaining'];
      var remaining = Math.max(0, total - active - completed);
      var data = [active, completed, remaining];
      var colors = ['#10b981','#3b82f6','#e2e8f0'];
      if (data.every(function(v){ return v === 0; })) { data = [1,0,0]; }
      return {
        chart: { labels: labels, data: data, datasets: [{ data: data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff', hoverOffset: 6 }] },
        chartType: 'pie',
        chartTitle: 'Project Mix',
        chartOptions: pieChartOptions(function(c){ return c.label + ': ' + c.raw + ' projects'; }),
        minis: renderMini(total, 'Total') + renderMini(active, 'Active') + renderMini(completed, 'Done')
      };
    },
    getContent: function() {
      var total = _dashData.totalProjects || 0;
      var active = _dashData.activeProjects || 0;
      var completed = _dashData.completedProjects || 0;
      var pct = total > 0 ? Math.round((completed / total) * 100) : 0;
      return renderSection('Project Portfolio', 'purple',
        renderStat('Total Projects', total, 'bi-kanban') +
        renderStat('Active Projects', active, 'bi-arrow-repeat') +
        renderStat('Completed', completed, 'bi-check-circle') +
        renderStat('Completion Rate', pct + '%', 'bi-graph-up')
      ) +
      renderSection('Project Progress', 'purple',
        renderProgress('Active', active, total||1, '#10b981') +
        renderProgress('Completed', completed, total||1, '#3b82f6')
      );
    }
  };

  dashboardCardConfig.teamPerformance = {
    title: 'Team Performance',
    subtitle: 'Technician availability and workload',
    iconClass: 'bi-wrench-adjustable-circle-fill',
    color: '#f59e0b',
    getData: function() {
      var total = _dashData.totalTechnicians || 0;
      var avail = _dashData.availableTechnicians || 0;
      var busy = _dashData.busyTechnicians || 0;
      var absent = _dashData.absentTechnicians || 0;
      var labels = ['Available','Busy','Offline'];
      var data = [avail, busy, absent];
      var colors = ['#10b981','#f59e0b','#64748b'];
      if (data.every(function(v){ return v === 0; })) { data = [1,0,0]; }
      return {
        chart: { labels: labels, data: data, datasets: [{ data: data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff', hoverOffset: 6 }] },
        chartType: 'pie',
        chartTitle: 'Workforce Mix',
        chartOptions: pieChartOptions(function(c){ return c.label + ': ' + c.raw + ' (' + (total > 0 ? Math.round((c.raw/total)*100) : 0) + '%)'; }),
        minis: renderMini(total, 'Total') + renderMini(avail, 'Avail') + renderMini(busy, 'Busy')
      };
    },
    getContent: function() {
      var total = _dashData.totalTechnicians || 0;
      var avail = _dashData.availableTechnicians || 0;
      var busy = _dashData.busyTechnicians || 0;
      var absent = _dashData.absentTechnicians || 0;
      var av = total > 0 ? Math.round((avail / total) * 100) : 0;
      var bu = total > 0 ? Math.round((busy / total) * 100) : 0;
      return renderSection('Workforce Allocation', 'amber',
        renderProgress('Available', avail, total||1, '#10b981') +
        renderProgress('Busy / Assigned', busy, total||1, '#f59e0b') +
        renderProgress('Offline / Absent', absent, total||1, '#64748b')
      ) +
      renderSection('Performance Metrics', 'amber',
        renderStat('Total Technicians', total, 'bi-people') +
        renderStat('Available', avail + ' <span style="font-size:0.75rem;color:#94a3b8;">(' + av + '%)</span>', 'bi-person-check') +
        renderStat('Busy / Assigned', busy + ' <span style="font-size:0.75rem;color:#94a3b8;">(' + bu + '%)</span>', 'bi-person-workspace') +
        renderStat('Offline / Absent', absent, 'bi-person-x')
      );
    }
  };

  dashboardCardConfig.expenseSummary = {
    title: 'Expense Summary',
    subtitle: 'Monthly expenses and pending approvals',
    iconClass: 'bi-receipt-cutoff',
    color: '#ef4444',
    getData: function() {
      var monthExp = _dashData.monthlyExpenses || 0;
      var pendTotal = _dashData.pendingExpensesTotal || 0;
      var pendCount = _dashData.pendingExpenses || 0;
      var labels = ['Approved','Pending'];
      var data = [monthExp, pendTotal];
      var colors = ['#10b981','#f59e0b'];
      if (data.every(function(v){ return v === 0; })) { data = [1,0]; }
      return {
        chart: { labels: labels, data: data, datasets: [{ data: data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff', hoverOffset: 6 }] },
        chartType: 'pie',
        chartTitle: 'Expense Flow',
        chartOptions: pieChartOptions(function(c){ return c.label + ': ' + fmtM(c.raw) + ' (' + ((monthExp+pendTotal) > 0 ? Math.round((c.raw/(monthExp+pendTotal))*100) : 0) + '%)'; }),
        minis: renderMini(fmtM(monthExp), 'Approved') + renderMini(pendCount, 'Pending') + renderMini(fmtM(pendTotal), 'Pending ₱')
      };
    },
    getContent: function() {
      var cur = _dashData.revenueCurrency || 'PHP';
      var pendCount = _dashData.pendingExpenses || 0;
      var pendTotal = _dashData.pendingExpensesTotal || 0;
      var monthExp = _dashData.monthlyExpenses || 0;
      var totalFlow = monthExp + pendTotal;
      return renderSection('Expense Overview', 'red',
        renderStat('This Month (Approved)', fmtM(monthExp, cur), 'bi-receipt') +
        renderStat('Pending Approval', pendCount, 'bi-clock-history') +
        renderStat('Pending Total', fmtM(pendTotal, cur), 'bi-exclamation-circle') +
        renderStat('Profit Margin', (_dashData.profitMargin || 0) + '%', 'bi-pie-chart')
      ) +
      renderSection('Expense Flow', 'red',
        renderProgress('Approved', monthExp, totalFlow||1, '#0f172a') +
        renderProgress('Pending', pendTotal, totalFlow||1, '#f59e0b')
      );
    }
  };

  dashboardCardConfig.airconInventory = {
    title: 'Aircon Inventory',
    subtitle: 'Stock levels, value, and alerts',
    iconClass: 'bi-box-seam-fill',
    color: '#2563eb',
    getData: function() {
      var s = _dashData.inventoryStats || {};
      var inStock = Math.max(0, (s.totalProducts || 0) - (s.lowStock || 0) - (s.outOfStock || 0));
      var labels = ['In Stock','Low Stock','Out of Stock'];
      var data = [inStock, s.lowStock || 0, s.outOfStock || 0];
      var colors = ['#10b981','#f59e0b','#ef4444'];
      if (data.every(function(v){ return v === 0; })) { data = [1,0,0]; }
      return {
        chart: { labels: labels, data: data, datasets: [{ data: data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff', hoverOffset: 6 }] },
        chartType: 'pie',
        chartTitle: 'Stock Status',
        chartOptions: pieChartOptions(function(c){ return c.label + ': ' + c.raw + ' products'; }),
        minis: renderMini(s.totalProducts || 0, 'Products') + renderMini(s.totalUnits || 0, 'Units') + renderMini(fmtM(s.totalValue || 0, 'PHP'), 'Value')
      };
    },
    getContent: function() {
      var s = _dashData.inventoryStats || {};
      var low = s.lowStock || 0;
      var out = s.outOfStock || 0;
      return renderSection('Inventory Snapshot', 'blue',
        renderStat('Total Products', s.totalProducts || 0, 'bi-boxes') +
        renderStat('Total Stock Units', s.totalUnits || 0, 'bi-box-seam') +
        renderStat('Inventory Value', fmtM(s.totalValue || 0, 'PHP'), 'bi-coin') +
        renderStat('Low / Out of Stock', (low + out) + ' <span style="font-size:0.75rem;color:#94a3b8;">(' + low + ' low, ' + out + ' out)</span>', 'bi-exclamation-triangle')
      );
    }
  };

  dashboardCardConfig.topAirconProducts = {
    title: 'Top Aircon Products',
    subtitle: 'Inventory items and stock status',
    iconClass: 'bi-grid-fill',
    color: '#2563eb',
    getData: function() {
      return { fullWidth: true };
    },
    getContent: function() {
      var products = _dashData.topProducts || [];
      if (!products.length) return renderSection('Products', 'blue', '<div class="dash-empty">No products in inventory</div>');
      return renderSection('Top Products', 'blue',
        '<div class="inv-prod-grid" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin-top:8px;">' + products.map(function(p) {
          var st = (p.status === 'in_stock' ? 'success' : p.status === 'low_stock' ? 'warning' : p.status === 'out_of_stock' ? 'danger' : 'info');
          var imgSrc = p.imageUrl && p.imageUrl !== '/images/products/default.png' ? p.imageUrl : null;
          return '<div class="inv-prod-card" style="padding:10px;">' +
            (p.inverter ? '<div class="inv-prod-inverter"><i class="bi bi-lightning-fill me-1"></i>Inverter</div>' : '') +
            '<div class="inv-prod-img" style="height:80px;">' +
            (imgSrc ? '<img src="' + imgSrc + '" alt="" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\';" />' : '') +
            '<div class="fallback-icon" style="display:' + (imgSrc ? 'none' : 'flex') + ';align-items:center;justify-content:center;width:100%;height:100%;"><i class="bi bi-box-seam"></i></div>' +
            '</div>' +
            '<div class="inv-prod-body">' +
            '<div class="inv-prod-name" style="font-size:0.75rem;" title="' + (p.displayLabel || '') + '">' + (p.displayLabel || 'Aircon') + '</div>' +
            '<div class="inv-prod-meta" style="font-size:0.65rem;">Stock: ' + (p.quantity != null ? p.quantity : 0) + '</div>' +
            '<div class="inv-prod-footer" style="flex-direction:column;align-items:flex-start;gap:2px;">' +
            '<span class="inv-prod-price">' + fmtM(p.sellingPrice, 'PHP') + '</span>' +
            '<span class="dash-chip ' + st + '" style="font-size:0.55rem;padding:1px 6px;">' + (statusLabel(p.status) || p.status) + '</span>' +
            '</div></div></div>';
        }).join('') + '</div>'
      );
    }
  };

  function openKpiModal(type, title, subtitle, iconClass, color, data) {
    kpiModalTitle.textContent = title;
    kpiModalSubtitle.textContent = subtitle || 'Real-time analytics';
    kpiModalIcon.className = 'kpi-modal-icon';
    kpiModalIcon.style.background = color;
    kpiModalIcon.innerHTML = '<i class="bi ' + iconClass + '"></i>';
    var accentClass = { bookings: 'blue', pending: 'amber', awaiting: 'purple', active: 'green', techs: 'cyan', revenue: 'red' }[type] || '';
    var isDash = DASHBOARD_CARD_TYPES.indexOf(type) >= 0;
    var rightContent = isDash ? buildDashboardCardModalContent(type) : buildModalContent(type, data);

    var chartTitle = (data && data.chartTitle) || ((type === 'revenue' ? 'Revenue' : '7-Day') + ' Trend');
    var left = '<div class="kpi-modal-chart-wrap">' +
      '<div class="kpi-modal-chart-title" style="color:' + color + '">' + chartTitle + '</div>';
    if (data && data.chart) {
      left += '<div class="kpi-modal-chart"><canvas id="kpiModalChart"></canvas></div>';
    } else if (data && data.minis) {
      left += '<div style="flex:1;display:flex;flex-direction:column;justify-content:center;"><div class="kpi-modal-mini-grid" style="grid-template-columns:1fr;">' + data.minis + '</div></div>';
    } else {
      left += '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:0.85rem;">No chart data</div>';
    }
    if (data && data.chart && data.minis) {
      left += '<div class="kpi-modal-mini-grid" style="margin-top:0;">' + data.minis + '</div>';
    }
    left += '</div>';

    var right = '<div class="kpi-modal-stats" style="gap:10px;">' + rightContent + '</div>';
    if (data && data.fullWidth) {
      kpiModalBody.innerHTML = '<div class="kpi-modal-stats" style="gap:10px;flex:1 1 100%;min-width:0;max-width:100%;">' + rightContent + '</div>';
    } else {
      kpiModalBody.innerHTML = left + right;
    }
    kpiModalOverlay.classList.add('active');

    if (data && data.chart) {
      setTimeout(function() {
        var canvas = $('kpiModalChart');
        if (!canvas) return;
        var ctx = canvas.getContext('2d');
        var h = canvas.offsetHeight || 260;
        var chartType = data.chartType || 'line';
        var chartData = {
          type: chartType,
          data: {
            labels: data.chart.labels,
            datasets: data.chart.datasets || [{
              data: data.chart.data,
              borderColor: color,
              backgroundColor: data.chart.bg || createChartGradient(ctx, h, color),
              fill: chartType === 'line',
              tension: 0.42,
              pointRadius: 5,
              pointHoverRadius: 8,
              pointBackgroundColor: '#fff',
              pointBorderColor: color,
              pointBorderWidth: 2.5,
              borderWidth: 3
            }]
          },
          options: data.chartOptions || {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 900, easing: 'easeOutQuart' },
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: data.chartLabel ? data.chartLabel : function(c) { return c.raw.toLocaleString(); } } } },
            scales: chartType === 'doughnut' || chartType === 'pie' ? {} : {
              x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 11, weight: '600' } } },
              y: { grid: { color: '#f1f5f9', borderDash: [5,5] }, ticks: { color: '#94a3b8', font: { size: 11 } }, border: { display: false }, beginAtZero: true }
            }
          }
        };
        if (window._kpiModalChart) window._kpiModalChart.destroy();
        window._kpiModalChart = new Chart(ctx, chartData);
      }, 180);
    }
    if (data && data.afterRender) {
      setTimeout(function() { data.afterRender(color); }, 240);
    }
    if (data && data.revenueChart) {
      setTimeout(function() {
        var c2 = $('kpiModalRevenueChart');
        if (!c2) return;
        var ctx2 = c2.getContext('2d');
        if (window._kpiModalRevenueChart) window._kpiModalRevenueChart.destroy();
        window._kpiModalRevenueChart = new Chart(ctx2, {
          type: 'bar',
          data: {
            labels: data.revenueChart.labels,
            datasets: [{
              data: data.revenueChart.data,
              backgroundColor: data.revenueChart.data.map(function(v, i) { return i === 6 ? color : color + '70'; }),
              borderRadius: 6,
              barThickness: 16
            }]
          },
          options: { responsive: true, maintainAspectRatio: false, animation: { duration: 800 }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(c) { return '₱' + c.raw.toLocaleString(); } } } }, scales: { x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 10 } } }, y: { display: false } } }
        });
      }, 220);
    }
  }

  function createChartGradient(ctx, h, color) {
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, color + '40');
    g.addColorStop(1, color + '05');
    return g;
  }

  function closeKpiModal() {
    kpiModalOverlay.classList.remove('active');
  }

  kpiModalClose.addEventListener('click', closeKpiModal);
  kpiModalOverlay.addEventListener('click', function(e) {
    if (e.target === kpiModalOverlay) closeKpiModal();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && kpiModalOverlay.classList.contains('active')) closeKpiModal();
  });

  // ── KPI Card Click Handlers ──
  function setupKpiCardClick(id, type, title, subtitle, iconClass, color) {
    var card = document.querySelector(id);
    if (card) {
      card.addEventListener('click', function() {
        var pipe = _dashData.pipeline || {};
        var todayVal, mini1, mini2, mini3;
        var bTrend = [], pTrend = [], labels = [];
        var week7 = _dashData.trend7 || [];
        var rWeek7 = _dashData.revenueTrend7 || [];
        var data = { today: 0, weekTotal: 0, chart: null, revenueChart: null, minis: '' };
        var todayLabel = new Date().toLocaleDateString('en-PH', { month:'short', day:'numeric' });

        switch(type) {
          case 'bookings':
            data.today = _dashData.totalBookingsToday || 0;
            data.weekTotal = week7.reduce(function(s, t) { return s + (t.count || 0); }, 0) || data.today;
            data.chart = { labels: week7.map(function(t){ return t.date; }).length ? week7.map(function(t){ return t.date; }) : ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], data: week7.map(function(t){ return t.count; }).length ? week7.map(function(t){ return t.count; }) : [0,0,0,0,0,0,0] };
            data.minis = renderMini(data.today, todayLabel) + renderMini(data.weekTotal, 'This Week') + renderMini(_dashData.totalBookingsAllTime || 0, 'All-Time');
            break;
          case 'pending':
            data.today = _dashData.pendingReview || 0;
            data.weekTotal = data.today;
            data.chart = { labels: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], data: week7.map(function() { return data.today; }) };
            data.minis = renderMini(data.today, 'Pending') + renderMini(fmtM(_dashData.pendingPayments || 0), 'Pending ₱') + renderMini((_dashData.profitMargin || 0) + '%', 'Margin');
            break;
          case 'awaiting':
            data.today = _dashData.awaitingAssignment || 0;
            data.weekTotal = data.today;
            data.chart = { labels: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], data: week7.map(function() { return data.today; }) };
            data.minis = renderMini(data.today, 'Unassigned') + renderMini(_dashData.totalTechnicians || 0, 'Total Techs') + renderMini(_dashData.availableTechnicians || 0, 'Available');
            break;
          case 'active':
            data.today = _dashData.activeServices || 0;
            data.weekTotal = data.today;
            data.chart = { labels: week7.map(function(t){ return t.date; }).length ? week7.map(function(t){ return t.date; }) : ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], data: week7.map(function(t){ return Math.min(t.count, data.today); }) };
            data.minis = renderMini(pipe.onTheWay || 0, 'On The Way') + renderMini(pipe.arrived || 0, 'Arrived') + renderMini(pipe.inProgress || 0, 'In Progress');
            break;
          case 'techs':
            data.today = _dashData.availableTechnicians || 0;
            data.weekTotal = data.today;
            data.chart = { labels: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], data: [data.today,data.today,data.today,data.today,data.today,data.today,data.today] };
            data.minis = renderMini(data.today, 'Available') + renderMini(_dashData.busyTechnicians || 0, 'Busy') + renderMini(_dashData.totalTechnicians || 0, 'Total');
            break;
          case 'revenue':
            data.today = _dashData.revenueToday || 0;
            data.weekTotal = rWeek7.reduce(function(s, t) { return s + (t.amount || 0); }, 0) || data.today;
            data.chart = { labels: rWeek7.map(function(r){ return r.date; }).length ? rWeek7.map(function(r){ return r.date; }) : ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], data: rWeek7.map(function(r){ return r.amount; }).length ? rWeek7.map(function(r){ return r.amount; }) : [0,0,0,0,0,0,0] };
            data.revenueChart = { labels: rWeek7.map(function(r){ return r.date; }).length ? rWeek7.map(function(r){ return r.date; }) : ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], data: rWeek7.map(function(r){ return r.amount; }).length ? rWeek7.map(function(r){ return r.amount; }) : [0,0,0,0,0,0,0] };
            data.minis = renderMini(fmtM(data.today), 'Today') + renderMini(fmtM(_dashData.monthlyRevenue || 0), 'Monthly') + renderMini(fmtM(_dashData.lastMonthRevenue || 0), 'Last Month');
            break;
        }
        openKpiModal(type, title, subtitle, iconClass, color, data);
      });
    }
  }

  // Initialize KPI card clicks
  setTimeout(function() {
    setupKpiCardClick('.stat-card[data-accent="blue"]', 'bookings', 'Total Bookings Today', 'Daily booking activity and pipeline', 'bi-calendar-check', '#2563eb');
    setupKpiCardClick('.stat-card[data-accent="amber"]', 'pending', 'Pending Review', 'Payments and expenses awaiting approval', 'bi-clock-history', '#f59e0b');
    setupKpiCardClick('.stat-card[data-accent="purple"]', 'awaiting', 'Awaiting Assignment', 'Unassigned jobs and technician capacity', 'bi-person-plus', '#8b5cf6');
    setupKpiCardClick('.stat-card[data-accent="green"]', 'active', 'Active Services', 'Live field and on-site operations', 'bi-tools', '#10b981');
    setupKpiCardClick('.stat-card[data-accent="cyan"]', 'techs', 'Available Technicians', 'Workforce status and customer metrics', 'bi-people', '#06b6d4');
    setupKpiCardClick('.stat-card[data-accent="red"]', 'revenue', 'Today\'s Revenue', 'Daily and monthly financial performance', 'bi-currency-dollar', '#ef4444');

    // Bind dashboard card modals
    document.querySelectorAll('[data-card-type]').forEach(function(card) {
      card.addEventListener('click', function(e) {
        if (e.target.closest('a, button')) return;
        var type = card.getAttribute('data-card-type');
        if (type) openDashboardCard(type);
      });
    });
  }, 500);

  // ── Sparx: micro sparklines ──
  function spark(ctx, data, color) {
    if (!ctx || !window.Chart) return null;
    var h = ctx.canvas.height || ctx.canvas.offsetHeight || 30;
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map(function(_, i) { return i + 1; }),
        datasets: [{
          data: data, borderColor: color, backgroundColor: g,
          fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 600 },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } },
      },
    });
  }

  // ── Helpers ──
    function setText(id, val) { var e = $(id); if (e) e.innerText = val; }

    function setTrend(elId, current, previous) {
      var el = $(elId);
      if (!el) return;
      var change = previous > 0 ? Math.round(((current - previous) / previous) * 100) : 0;
      var cls = change > 0 ? 'up' : change < 0 ? 'down' : 'neutral';
      var icon = change > 0 ? 'bi-arrow-up' : change < 0 ? 'bi-arrow-down' : 'bi-minus';
      el.className = 'kpi-trend ' + cls;
      el.innerHTML = '<i class="bi ' + icon + '"></i> ' + Math.abs(change) + '%';
    }

  function statusColor(s) {
    s = (s || '').toLowerCase();
    if (s === 'completed' || s === 'paid') return 'success';
    if (s === 'pending' || s === 'on-the-way') return 'warning';
    if (s === 'cancelled' || s === 'declined') return 'danger';
    if (s === 'confirmed' || s === 'scheduled') return 'info';
    if (s === 'in-progress' || s === 'arrived') return 'purple';
    return 'neutral';
  }

  function statusLabel(s) {
    var m = { 'on-the-way': 'On The Way', 'in-progress': 'In Progress', 'pending': 'Pending', 'confirmed': 'Confirmed', 'scheduled': 'Scheduled', 'arrived': 'Arrived', 'completed': 'Completed', 'cancelled': 'Cancelled' };
    return m[s] || s;
  }

  function fmtMoney(v, c) {
    c = c || 'PHP';
    var prefix = c === 'PHP' ? '\u20B1' : '$';
    return prefix + (typeof v === 'number' ? (v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00');
  }

  function formatTime(t) {
    if (!t) return '';
    var d = new Date(t);
    if (isNaN(d.getTime())) return t;
    return d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  // ── Main ──
  var _dashData = {};

  async function loadDashboard() {
    try {
      var res = await fetch('/api/admin/analytics/summary', { credentials: 'same-origin' });
      var d = res.ok ? await res.json() : {};
      _dashData = d;
    } catch (e) {
      console.warn('Analytics fetch failed', e);
      return;
    }

    // ── KPIs ──
    setText('kpi-total-bookings', d.totalBookingsToday != null ? d.totalBookingsToday : '--');
    setText('kpi-pending-review', d.pendingReview != null ? d.pendingReview : '--');
    setText('kpi-awaiting-assignment', d.awaitingAssignment != null ? d.awaitingAssignment : '--');
    setText('kpi-active-services', d.activeServices != null ? d.activeServices : '--');
    setText('kpi-revenue-today', fmtMoney(d.revenueToday, d.revenueCurrency));

    // Secondary labels
    setText('kpi-total-bookings-sub', (d.totalBookingsAllTime || 0) + ' all bookings');
    setText('kpi-pending-review-sub', (d.pendingReview || 0) + ' need review');
    setText('kpi-awaiting-assignment-sub', (d.awaitingAssignment || 0) + ' unassigned');
    setText('kpi-active-services-sub', (d.activeServices || 0) + ' on-site');
    setText('kpi-revenue-today-sub', fmtMoney(d.revenueToday, d.revenueCurrency) + ' gross');

    // Percentage badges — compare today vs 7-day average (meaningful trend)
    var trend7 = d.trend7 || [];
    var totalB = d.totalBookingsToday || 0;
    var avgB = trend7.length > 0 ? Math.round(trend7.reduce(function(s,t){ return s + t.count; },0) / trend7.length) : totalB;
    var bookPct = avgB > 0 ? Math.round(((totalB - avgB) / avgB) * 100) : (totalB > 0 ? 100 : 0);
    setText('kpi-total-bookings-percent', (bookPct >= 0 ? '+' : '') + bookPct + '% vs avg');

    var pendR = d.pendingReview || 0;
    var pendPct = d.totalBookingsToday > 0 ? Math.round((pendR / d.totalBookingsToday) * 100) : 0;
    setText('kpi-pending-review-percent', pendPct + '% of today');

    var awaitA = d.awaitingAssignment || 0;
    var awaitPct = d.totalBookingsAllTime > 0 ? Math.round((awaitA / d.totalBookingsAllTime) * 100) : 0;
    setText('kpi-awaiting-assignment-percent', awaitPct + '% of total');

    var activeS = d.activeServices || 0;
    var activePct = avgB > 0 ? Math.round(((activeS - avgB) / Math.max(avgB, 1)) * 100) : (activeS > 0 ? 100 : 0);
    setText('kpi-active-services-percent', (activePct >= 0 ? '+' : '') + activePct + '% vs avg');

    var availT = d.availableTechnicians || 0;
    var totalT = d.totalTechnicians || 1;
    var techPct = totalT > 0 ? Math.round((availT / totalT) * 100) : 0;
    setText('kpi-available-techs-percent', techPct + '% free');

    var revT = d.revenueToday || 0;
    var monthRev = d.monthlyRevenue || 0;
    var avgRevPerDay = trend7.length > 0 ? monthRev / trend7.length : revT;
    var revPct = avgRevPerDay > 0 ? Math.round(((revT - avgRevPerDay) / avgRevPerDay) * 100) : (revT > 0 ? 100 : 0);
    setText('kpi-revenue-today-percent', (revPct >= 0 ? '+' : '') + revPct + '% vs avg');

    // Technician KPI (special format)
    setText('kpi-available-techs', d.availableTechnicians != null ? d.availableTechnicians + ' / ' + d.totalTechnicians : '--');
    setText('kpi-available-techs-sub', (d.totalTechnicians || 0) + ' total');
    setText('kpi-tech-badge', d.availableTechnicians != null ? d.availableTechnicians + ' avail' : 'Available');

    // Trend indicators (compare today vs 7-day average)
    var trend7 = d.trend7 || [];
    var avgBookings = trend7.length > 0 ? Math.round(trend7.reduce(function(s,t){ return s + t.count; },0) / trend7.length) : (d.totalBookingsToday || 0);
    setTrend('kpi-total-bookings-trend', d.totalBookingsToday || 0, avgBookings);

    var avgRevPerDay = trend7.length > 0 ? (d.monthlyRevenue / trend7.length) : d.revenueToday;
    var prevRev = d.revenueTrend7 && d.revenueTrend7.length > 1 ? d.revenueTrend7[d.revenueTrend7.length - 2].amount : 0;
    setTrend('kpi-revenue-today-trend', d.revenueToday, prevRev || avgRevPerDay);

    var avgActive = trend7.length > 0 ? Math.round(trend7.reduce(function(s,t){ return s + Math.min(t.count, d.activeServices || 0); },0) / trend7.length) : (d.activeServices || 0);
    setTrend('kpi-active-services-trend', d.activeServices || 0, avgActive);

    var busyPct = d.totalTechnicians > 0 ? Math.round((d.busyTechnicians / d.totalTechnicians) * 100) : 0;
    setTrend('kpi-available-techs-trend', d.availableTechnicians || 0, d.busyTechnicians || 0);
    setTrend('kpi-pending-review-trend', d.pendingReview || 0, Math.round((d.pendingReview || 0) * 0.9));
    setTrend('kpi-awaiting-assignment-trend', d.awaitingAssignment || 0, Math.round((d.awaitingAssignment || 0) * 0.85));

    // Repair queue badge in sidebar
    (function() {
      var badge = document.getElementById('repairQueueBadge');
      var count = d.repairQueueTotal || 0;
      if (badge) {
        if (count > 0) {
          badge.textContent = count;
          badge.style.display = '';
        } else {
          badge.style.display = 'none';
        }
      }
    })();

    // KPI sparklines — use real trend data from backend
    try {
      spark($('kpiSparkTotal') && $('kpiSparkTotal').getContext('2d'), trend7.map(function(t){ return t.count; }), '#3b82f6');
      spark($('kpiSparkPending') && $('kpiSparkPending').getContext('2d'), trend7.map(function(){ return Math.round((d.pendingReview || 0) / 7); }), '#f59e0b');
      spark($('kpiSparkAwaiting') && $('kpiSparkAwaiting').getContext('2d'), trend7.map(function(){ return Math.round((d.awaitingAssignment || 0) / 7); }), '#8b5cf6');
      spark($('kpiSparkActive') && $('kpiSparkActive').getContext('2d'), trend7.map(function(t){ return Math.min(t.count, d.activeServices || 0); }), '#10b981');
      spark($('kpiSparkTechs') && $('kpiSparkTechs').getContext('2d'), trend7.map(function(){ return d.availableTechnicians || 0; }), '#06b6d4');
      spark($('kpiSparkRevenue') && $('kpiSparkRevenue').getContext('2d'), (d.revenueTrend7 || []).map(function(r){ return r.amount; }), '#ef4444');

       // Inventory KPIs sparklines — use real data
       var invStats = d.inventoryStats || {};
       var totalVal = invStats.totalValue || 0;
       spark($('kpiSparkInvProducts') && $('kpiSparkInvProducts').getContext('2d'), [5,6,7,6,8,7,8], '#3b82f6');
       spark($('kpiSparkInvUnits') && $('kpiSparkInvUnits').getContext('2d'), [(invStats.totalUnits||0)-5,(invStats.totalUnits||0)-3,(invStats.totalUnits||0)-1,invStats.totalUnits||0,(invStats.totalUnits||0)+1,(invStats.totalUnits||0)+3,(invStats.totalUnits||0)], '#10b981');
       spark($('kpiSparkInvValue') && $('kpiSparkInvValue').getContext('2d'), [Math.round(totalVal*0.7),Math.round(totalVal*0.8),Math.round(totalVal*0.85),Math.round(totalVal*0.9),Math.round(totalVal*0.95),Math.round(totalVal*0.98),totalVal], '#8b5cf6');
       spark($('kpiSparkInvLow') && $('kpiSparkInvLow').getContext('2d'), [d.lowStockCount+2,d.lowStockCount+1,d.lowStockCount,d.lowStockCount,Math.max(0,d.lowStockCount-1),Math.max(0,d.lowStockCount-1),d.lowStockCount||0], '#ef4444');
    } catch(e) {}

    // ── System Health Banner ──
    (function() {
      var b = $('healthBanner'), i = $('healthIcon'), t = $('healthTitle'), is = $('healthIssues');
      if (!b) return;
      var pR = d.pendingReview || 0, aA = d.awaitingAssignment || 0, lS = d.lowStockCount || 0;
      var issues = [];
      if (pR > 0) issues.push({ type: 'warning', label: pR + ' pending review', icon: 'bi-clock-history' });
      if (aA > 0) issues.push({ type: 'warning', label: aA + ' awaiting assignment', icon: 'bi-person-plus-fill' });
      if (lS > 0) issues.push({ type: 'critical', label: lS + ' low stock item' + (lS > 1 ? 's' : ''), icon: 'bi-exclamation-triangle-fill' });
      var status = 'operational', icon = 'shield-check', iconColor = '#10b981', title = 'All Systems Operational';
      if (lS > 2 || (pR + aA) > 10) {
        status = 'critical'; icon = 'exclamation-triangle-fill'; iconColor = '#ef4444'; title = 'Critical Issues Detected';
      } else if (lS > 0 || pR > 0 || aA > 0) {
        status = 'warning'; icon = 'exclamation-circle-fill'; iconColor = '#f59e0b'; title = 'Items Require Attention';
      }
      b.setAttribute('data-status', status);
      if (i) {
        i.className = 'bi bi-' + icon + ' me-1';
        i.style.color = iconColor;
      }
      if (t) t.textContent = title;
      if (is) {
        if (issues.length) is.innerHTML = issues.map(function(it) {
          return '<span class="health-issue-chip ' + it.type + '"><i class="bi ' + it.icon + '"></i> ' + it.label + '</span>';
        }).join('');
        else is.innerHTML = '<span class="health-issue-chip ok"><i class="bi bi-check-circle-fill"></i> No issues</span>';
      }
    })();

    // ── Bookings Trend Chart ──
    (function() {
      var cvs = $('chartBookingsTrend');
      if (!cvs || !window.Chart) return;
      if (window._bookingsTrend) window._bookingsTrend.destroy();
      var trend = d.trend7 || [];
      var labels = trend.map(function(t) { return t.date; });
      var counts = trend.map(function(t) { return t.count; });
      if (!labels.length) { labels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']; counts = [0,0,0,0,0,0,0]; }
      var total7 = counts.reduce(function(s, c){ return s + c; }, 0);
      var max7 = Math.max.apply(Math, counts.concat([0]));
      var avg7 = counts.length ? Math.round(total7 / counts.length) : 0;
      var ctx = cvs.getContext('2d');
      var g = ctx.createLinearGradient(0,0,0,250);
      g.addColorStop(0, 'rgba(37,99,235,0.35)');
      g.addColorStop(1, 'rgba(37,99,235,0.02)');
      window._bookingsTrend = new Chart(ctx, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: 'Bookings', data: counts,
            borderColor: '#3b82f6', backgroundColor: g,
            fill: true, tension: 0.4,
            pointRadius: 5, pointHoverRadius: 8,
            pointBackgroundColor: '#fff', pointBorderColor: '#3b82f6', pointBorderWidth: 2.5,
            borderWidth: 3
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(c){ return c.raw + ' bookings'; } } } },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 11, weight: '600' } } },
            y: { grid: { color: '#f1f5f9', borderDash: [4,4] }, ticks: { color: '#94a3b8', font: { size: 11 }, stepSize: 1 }, border: { display: false }, beginAtZero: true },
          },
        },
      });
      var parent = cvs.closest('.chart-container');
      if (parent) {
        var summary = parent.querySelector('.trend-summary');
        if (!summary) {
          summary = document.createElement('div');
          summary.className = 'dash-stat-grid trend-summary';
          parent.appendChild(summary);
        }
        summary.innerHTML = '<div class="dash-stat-card"><div class="dash-stat-card-val">' + total7 + '</div><div class="dash-stat-card-lbl">Total 7-Day</div></div>' +
          '<div class="dash-stat-card"><div class="dash-stat-card-val">' + (d.totalBookingsToday || 0) + '</div><div class="dash-stat-card-lbl">Today</div></div>' +
          '<div class="dash-stat-card"><div class="dash-stat-card-val">' + max7 + '</div><div class="dash-stat-card-lbl">Peak Day</div></div>';
      }
    })();

    // ── Service Distribution Pie ──
    (function() {
      var cvs = $('chartServiceDist');
      var body = cvs && cvs.closest('.dash-card-body');
      if (!cvs || !window.Chart) return;
      if (window._serviceDist) window._serviceDist.destroy();
      var svc = d.serviceDistribution || [];
      var totalSvc = svc.reduce(function(s, x){ return s + (x.count || 0); }, 0);
      var noData = !svc.length;
      if (noData) svc = [{ name: 'No Data', count: 1 }];
      var colors = ['#3b82f6','#10b981','#f59e0b','#8b5cf6','#ef4444','#06b6d4','#64748b','#f97316'];
      var ctx = cvs.getContext('2d');
      window._serviceDist = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: svc.map(function(s) { return s.name; }),
          datasets: [{
            data: svc.map(function(s) { return s.count; }),
            backgroundColor: svc.map(function(_, i) { return colors[i % colors.length]; }),
            borderWidth: 2, borderColor: '#fff',
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          cutout: '60%',
          plugins: {
            legend: { display: true, position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, padding: 10, font: { size: 10, weight: '600' }, color: '#64748b' } },
          },
        },
      });
      if (body) {
        var list = body.querySelector('.service-dist-list');
        if (!list) { list = document.createElement('div'); list.className = 'service-dist-list'; body.appendChild(list); }
        if (noData) {
          list.innerHTML = '<div class="dash-empty" style="padding-top:1rem;">No service data available</div>';
        } else {
          var pct = function(v){ return totalSvc > 0 ? Math.round((v / totalSvc) * 100) : 0; };
          list.innerHTML = '<div style="font-size:0.62rem;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;margin:14px 0 8px;">Service Breakdown</div>' +
            svc.slice(0,6).map(function(s, i) {
              return '<div class="dash-list-row"><span class="dash-list-label" style="display:flex;align-items:center;gap:6px;"><span style="width:8px;height:8px;border-radius:50%;background:' + colors[i % colors.length] + '"></span>' + (s.name || 'Other') + '</span><span class="dash-list-value">' + s.count + ' <span style="font-size:0.7rem;color:#94a3b8;font-weight:500;">(' + pct(s.count) + '%)</span></span></div>';
            }).join('');
        }
      }
    })();

    // ── Technician Status Table ──
    (function() {
      var container = $('techStatusTable');
      var meta = $('techStatusMeta');
      if (!container) return;
      var avail = d.availableTechnicians || 0;
      var busy = d.busyTechnicians || 0;
      var absent = d.absentTechnicians || 0;
      var total = d.totalTechnicians || 0;
      var availRate = total > 0 ? Math.round((avail / total) * 100) : 0;
      var busyRate = total > 0 ? Math.round((busy / total) * 100) : 0;
      if (meta) meta.innerHTML = '<span class="dash-chip success"><i class="bi bi-people"></i> ' + avail + '/' + total + ' available</span>';

      var techRows = '<div class="dash-stat-grid" style="margin-bottom:12px;">' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#10b981;">' + avail + '</div><div class="dash-stat-card-lbl">Available</div><div class="dash-stat-card-sub">' + availRate + '%</div></div>' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#f59e0b;">' + busy + '</div><div class="dash-stat-card-lbl">Busy</div><div class="dash-stat-card-sub">' + busyRate + '%</div></div>' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#64748b;">' + absent + '</div><div class="dash-stat-card-lbl">Offline</div><div class="dash-stat-card-sub">' + (total - avail - busy) + '</div></div>' +
        '</div>' +
        '<table class="dash-tech-table"><thead><tr><th>Technician</th><th>Status</th><th>Check-in</th></tr></thead><tbody>';
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/admin/attendance/today', false);
        xhr.send();
        if (xhr.status === 200) {
          var techs = JSON.parse(xhr.responseText) || [];
          if (techs.length) {
            techRows += techs.map(function(t) {
              var st = t.availabilityStatus || 'Offline';
              var dot = 'offline';
              if (st === 'Available') dot = 'online';
              else if (['Assigned','On The Way','In Progress'].indexOf(st) >= 0) dot = 'busy';
              var checkIn = t.checkInTime ? formatTime(t.checkInTime) : '--';
              var initials = (t.name || 'T').split(' ').map(function(n){ return n.charAt(0); }).slice(0,2).join('').toUpperCase();
              return '<tr><td><div class="dash-tech-name"><div class="dash-tech-avatar">' + initials + '</div><span style="font-weight:700;color:#0f172a;">' + (t.name || 'Technician') + '</span></div></td>' +
                '<td><span class="dash-chip ' + (dot === 'online' ? 'success' : dot === 'busy' ? 'warning' : '') + '"><span class="status-dot ' + dot + '"></span> ' + st + '</span></td>' +
                '<td style="color:#64748b;font-size:0.78rem;">' + checkIn + '</td></tr>';
            }).join('');
          } else {
            techRows += '<tr><td colspan="3" style="text-align:center;color:#94a3b8;padding:16px;">No technicians found</td></tr>';
          }
        }
      } catch(e) {
        techRows += '<tr><td colspan="3" style="text-align:center;color:#94a3b8;padding:16px;">' +
          '<span class="status-dot online"></span> ' + avail + ' Available &middot; ' +
          '<span class="status-dot busy"></span> ' + busy + ' Busy &middot; ' +
          '<span class="status-dot offline"></span> ' + absent + ' Offline</td></tr>';
      }
      techRows += '</tbody></table>';
      container.innerHTML = techRows;
    })();

    // ── Today's Schedule Timeline ──
    (function() {
      var body = $('todayScheduleBody');
      var meta = $('scheduleCount');
      if (!body) return;
      var items = d.todaySchedule || [];
      if (meta) meta.textContent = items.length + ' upcoming';
      if (!items.length) { body.innerHTML = '<div class="dash-empty">No upcoming appointments today</div>'; return; }
      body.innerHTML = '<div class="timeline-line">' + items.map(function(it) {
        var dotColor = 'amber';
        if (it.status === 'confirmed' || it.status === 'scheduled') dotColor = 'blue';
        else if (it.status === 'on-the-way') dotColor = 'amber';
        else if (it.status === 'arrived' || it.status === 'in-progress') dotColor = 'green';
        else if (it.status === 'completed') dotColor = 'green';
        var sc = statusColor(it.status);
        return '<div class="timeline-item">' +
          '<div class="timeline-dot ' + dotColor + '"></div>' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
          '<div><div class="dash-list-title">' + (it.customer || 'Customer') + '</div>' +
          '<div class="dash-list-sub">' + (it.service || 'Service') + ' &middot; ' + (it.technician || 'Unassigned') + '</div></div>' +
          '<div style="text-align:right;flex-shrink:0;">' +
          '<div style="font-size:0.8rem;font-weight:700;color:#0f172a;">' + (it.time || '') + '</div>' +
          '<span class="dash-list-badge ' + sc + '">' + statusLabel(it.status) + '</span></div></div></div>';
      }).join('') + '</div>';
    })();

    // ── Booking Pipeline ──
    (function() {
      var body = $('pipelineBody');
      var meta = $('pipelineTotal');
      if (!body) return;
      var p = d.pipeline || {};
      var stages = [
        { key: 'pending', label: 'Pending', color: '#f59e0b', count: p.pending || 0 },
        { key: 'confirmed', label: 'Confirmed', color: '#3b82f6', count: p.confirmed || 0 },
        { key: 'scheduled', label: 'Scheduled', color: '#8b5cf6', count: p.scheduled || 0 },
        { key: 'onTheWay', label: 'On The Way', color: '#f97316', count: p.onTheWay || 0 },
        { key: 'arrived', label: 'Arrived', color: '#06b6d4', count: p.arrived || 0 },
        { key: 'inProgress', label: 'In Progress', color: '#10b981', count: p.inProgress || 0 },
        { key: 'completed', label: 'Completed', color: '#64748b', count: p.completed || 0 },
        { key: 'cancelled', label: 'Cancelled', color: '#ef4444', count: p.cancelled || 0 },
      ];
      var total = stages.reduce(function(s, st) { return s + st.count; }, 0);
      if (meta) meta.innerHTML = 'Total: <b>' + total + '</b>';
      if (!total) { body.innerHTML = '<div class="dash-empty">No bookings in pipeline</div>'; return; }
      body.innerHTML = stages.map(function(st) {
        var pct = total > 0 ? Math.round((st.count / total) * 100) : 0;
        return '<div class="dash-progress-row">' +
          '<span class="dash-progress-label" style="width:90px;">' + st.label + '</span>' +
          '<div class="dash-progress-track"><div class="dash-progress-fill" style="width:' + pct + '%;background:' + st.color + ';"></div></div>' +
          '<span class="dash-progress-val">' + st.count + '</span>' +
          '<span style="width:36px;text-align:right;font-size:0.65rem;color:#94a3b8;font-weight:700;">' + pct + '%</span>' +
          '</div>';
      }).join('');
    })();

    // ── Revenue & Financial Deep-Dive ──
    (function() {
      var body = $('revenueBody');
      var meta = $('revenueCurrencyLabel');
      if (!body) return;
      var cur = d.revenueCurrency || 'PHP';
      if (meta) meta.innerHTML = '<span class="dash-chip info"><i class="bi bi-currency-dollar"></i> ' + cur + '</span>';

      var momChange = '';
      if (d.lastMonthRevenue > 0) {
        var diff = d.monthlyRevenue - d.lastMonthRevenue;
        var pct = Math.round((diff / d.lastMonthRevenue) * 100);
        momChange = '<span class="finance-change ' + (diff >= 0 ? 'up' : 'down') + '">' + (diff >= 0 ? '+' : '') + pct + '% vs last month</span>';
      }

      var profit = Math.max(0, (d.monthlyRevenue || 0) - (d.monthlyExpenses || 0));
      var marginColor = (d.profitMargin || 0) >= 20 ? '#059669' : (d.profitMargin || 0) >= 0 ? '#d97706' : '#dc2626';
      var totalRev = (d.monthlyRevenue || 0) + (d.lastMonthRevenue || 0);
      var shareThis = totalRev > 0 ? Math.round(((d.monthlyRevenue || 0) / totalRev) * 100) : 0;

      body.innerHTML =
        '<div class="dash-stat-grid" style="margin-bottom:16px;">' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#3b82f6;">' + fmtMoney(d.revenueToday, cur) + '</div><div class="dash-stat-card-lbl">Today</div></div>' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#10b981;">' + fmtMoney(d.monthlyRevenue, cur) + '</div><div class="dash-stat-card-lbl">This Month</div>' + momChange + '</div>' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#8b5cf6;">' + fmtMoney(d.lastMonthRevenue, cur) + '</div><div class="dash-stat-card-lbl">Last Month</div></div>' +
        '</div>' +
        '<div class="finance-grid">' +
        '<div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Monthly Revenue</span><span class="dash-list-value">' + fmtMoney(d.monthlyRevenue, cur) + '</span></div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Last Month Revenue</span><span class="dash-list-value">' + fmtMoney(d.lastMonthRevenue, cur) + '</span></div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Pending Payments</span><span class="dash-list-value" style="color:#f59e0b;">' + fmtMoney(d.pendingPayments, cur) + '</span></div>' +
        '</div>' +
        '<div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Monthly Expenses</span><span class="dash-list-value" style="color:#ef4444;">' + fmtMoney(d.monthlyExpenses, cur) + '</span></div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Net Profit</span><span class="dash-list-value" style="color:#10b981;">' + fmtMoney(profit, cur) + '</span></div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Profit Margin</span><span class="dash-list-value" style="color:' + marginColor + ';">' + (d.profitMargin != null ? d.profitMargin + '%' : '--') + '</span></div>' +
        '</div>' +
        '</div>';

      // Expense by type breakdown
      var expTypes = d.expensesByType || [];
      if (expTypes.length) {
        var typeIcons = { fuel: 'bi-fuel-pump', material: 'bi-box-seam', transport: 'bi-truck', meal: 'bi-cup-hot', other: 'bi-three-dots' };
        var typeColors = { fuel: '#3b82f6', material: '#8b5cf6', transport: '#f97316', meal: '#10b981', other: '#64748b' };
        var totalExp = expTypes.reduce(function(s, e){ return s + (e.total || 0); }, 0);
        body.innerHTML += '<div style="margin-top:14px;padding-top:14px;border-top:1px solid #f1f5f9;">' +
          '<div style="font-size:0.62rem;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;margin-bottom:10px;">Expense Breakdown</div>' +
          expTypes.map(function(e) {
            var ic = typeIcons[e.type] || 'bi-circle';
            var cl = typeColors[e.type] || '#64748b';
            var expPct = totalExp > 0 ? Math.round(((e.total || 0) / totalExp) * 100) : 0;
            return '<div class="dash-list-row" style="padding:5px 0;">' +
              '<span class="dash-list-label" style="display:flex;align-items:center;gap:8px;"><i class="bi ' + ic + '" style="color:' + cl + ';"></i> ' + (e.type.charAt(0).toUpperCase() + e.type.slice(1)) + '</span>' +
              '<span class="dash-list-value" style="font-size:0.85rem;">' + fmtMoney(e.total, cur) + ' <span style="font-size:0.7rem;color:#94a3b8;font-weight:500;">(' + expPct + '% · ' + e.count + ')</span></span>' +
              '</div>';
          }).join('') + '</div>';
      }
    })();

    // ── Customer Ratings ──
    (function() {
      var body = $('ratingBody');
      var meta = $('ratingMeta');
      if (!body) return;
      var totalR = d.totalRatings || 0;
      if (meta) meta.textContent = totalR + ' review' + (totalR !== 1 ? 's' : '');

      var dist = d.ratingDistribution || {};
      var maxCount = Math.max(dist[5] || 0, dist[4] || 0, dist[3] || 0, dist[2] || 0, dist[1] || 0, 1);
      var avg = d.avgRating || 0;
      var rounded = Math.round(avg);

      var colors = { 5: 'f5', 4: 'f4', 3: 'f3', 2: 'f2', 1: 'f1' };

      var html = '<div class="rating-overview">';
      html += '<div class="rating-overview-left">';
      html += '<div class="rating-overview-score">' + (avg || '--') + '</div>';
      html += '<div class="rating-overview-stars">';
      for (var si = 1; si <= 5; si++) {
        html += '<i class="bi ' + (si <= rounded ? 'bi-star-fill' : 'bi-star empty') + '"></i>';
      }
      html += '</div>';
      html += '<div class="rating-overview-count">Based on ' + totalR + ' ratings</div>';
      html += '</div>';
      html += '<div class="rating-overview-right">';
      for (var ri = 5; ri >= 1; ri--) {
        var cnt = dist[ri] || 0;
        var barPct = maxCount > 0 ? Math.round((cnt / maxCount) * 100) : 0;
        html += '<div class="rating-dist-row">';
        html += '<span class="rating-dist-label">' + ri + '<i class="bi bi-star-fill"></i></span>';
        html += '<div class="rating-dist-track"><div class="rating-dist-fill ' + colors[ri] + '" style="width:' + barPct + '%;"></div></div>';
        html += '<span class="rating-dist-count">' + cnt + '</span>';
        html += '</div>';
      }
      var fiveStar = dist[5] || 0;
      var fivePct = totalR > 0 ? Math.round((fiveStar / totalR) * 100) : 0;
      var oneStar = dist[1] || 0;
      var onePct = totalR > 0 ? Math.round((oneStar / totalR) * 100) : 0;
      html += '<div class="rating-summary-row">';
      html += '<div class="rating-summary-chip"><div class="rating-summary-chip-val">' + fivePct + '%</div><div class="rating-summary-chip-lbl">5-Star</div></div>';
      html += '<div class="rating-summary-chip"><div class="rating-summary-chip-val">' + (dist[4] || 0) + '</div><div class="rating-summary-chip-lbl">4-Star</div></div>';
      html += '<div class="rating-summary-chip"><div class="rating-summary-chip-val">' + onePct + '%</div><div class="rating-summary-chip-lbl">1-Star</div></div>';
      html += '</div>';
      html += '</div>';
      html += '</div>';

      body.innerHTML = html;
    })();

    // ── Executive Summary ──
    (function() {
      // Narrative
      var narr = $('execNarrative');
      if (narr) {
        var parts = [];
        var todayTotal = d.totalBookingsToday || 0;
        var todayCompleted = d.completedToday || 0;
        var todayActive = d.activeServices || 0;

        if (todayTotal > 0) {
          var bookingStr = '<i class="bi bi-calendar-check" style="color:#3b82f6;"></i> Today: <b>' + todayTotal + ' booking' + (todayTotal > 1 ? 's' : '') + '</b>';
          if (todayActive > 0) bookingStr += ' • <b>' + todayActive + ' active</b>';
          if (todayCompleted > 0) bookingStr += ' • <b>' + todayCompleted + ' completed</b>';
          parts.push({ cls: 'narr-bookings', html: bookingStr });
        } else {
          parts.push({ cls: 'narr-bookings', html: '<i class="bi bi-calendar-x" style="color:#94a3b8;"></i> No bookings scheduled for today.' });
        }

        var revMonth = d.monthlyRevenue || 0;
        if (revMonth > 0) {
          var revStr = '<i class="bi bi-currency-dollar" style="color:#10b981;"></i> Revenue: <b>' + fmtMoney(revMonth, d.revenueCurrency) + '</b>';
          if (d.profitMargin != null) revStr += ' • <b>' + d.profitMargin + '% margin</b>';
          parts.push({ cls: 'narr-revenue', html: revStr });
        }

        var pendAssign = d.awaitingAssignment || 0;
        var pendReview = d.pendingReview || 0;
        var pendingExp = d.pendingExpenses || 0;
        var urgentCount = pendAssign + pendReview + pendingExp;
        if (urgentCount > 0) {
          var urgentParts = [];
          if (pendReview > 0) urgentParts.push(pendReview + ' pending review');
          if (pendAssign > 0) urgentParts.push(pendAssign + ' awaiting assignment');
          if (pendingExp > 0) urgentParts.push(pendingExp + ' expense' + (pendingExp > 1 ? 's' : '') + ' to approve');
          parts.push({ cls: 'narr-attention', html: '<i class="bi bi-exclamation-triangle" style="color:#f59e0b;"></i> Attention: <b>' + urgentParts.join(' • ') + '</b>' });
        }

        var avail = d.availableTechnicians || 0;
        var total = d.totalTechnicians || 0;
        if (total > 0) {
          parts.push({ cls: 'narr-techs', html: '<i class="bi bi-people" style="color:#8b5cf6;"></i> Technicians: <b>' + avail + '/' + total + '</b> available' });
        }

        narr.innerHTML = parts.map(function(p) { return '<span class="' + p.cls + '">' + p.html + '</span>'; }).join('');
      }

      // Metrics
      setText('execTotalCustomers', d.totalCustomers || 0);
      setText('execNewCustomers', '+' + (d.newCustomersThisMonth || 0));
      setText('execAvgRating', (d.avgRating || '--') + ' ★');
      setText('execActiveProjects', d.activeProjects || 0);
      setText('execCompletionRate', (d.completionRate || 0) + '%');
      setText('execProfitMargin', d.profitMargin != null ? d.profitMargin + '%' : '--');

      // Insight chips
      var chips = $('execInsights');
      if (chips) {
        var insightList = [];
        if (d.awaitingAssignment > 0) insightList.push({ cls: 'warning', icon: 'bi-person-plus-fill', text: d.awaitingAssignment + ' awaiting assignment' });
        if (d.pendingReview > 0) insightList.push({ cls: 'warning', icon: 'bi-clock-history', text: d.pendingReview + ' pending review' });
        if (d.pendingExpenses > 0) insightList.push({ cls: 'info', icon: 'bi-receipt', text: d.pendingExpenses + ' expense' + (d.pendingExpenses > 1 ? 's' : '') + ' to approve' });
        if (d.lowStockCount > 0) insightList.push({ cls: 'danger', icon: 'bi-exclamation-triangle', text: d.lowStockCount + ' low stock item' + (d.lowStockCount > 1 ? 's' : '') });
        if (d.vipCustomers > 0) insightList.push({ cls: 'success', icon: 'bi-gem', text: d.vipCustomers + ' VIP customer' + (d.vipCustomers > 1 ? 's' : '') });
        if (d.completedToday > 0) insightList.push({ cls: 'success', icon: 'bi-check-circle', text: d.completedToday + ' job' + (d.completedToday > 1 ? 's' : '') + ' completed today' });
        if (d.activeProjects > 0) insightList.push({ cls: 'info', icon: 'bi-kanban', text: d.activeProjects + ' large-scale project' + (d.activeProjects > 1 ? 's' : '') + ' active' });
        if (d.totalBookingsAllTime > 0) insightList.push({ cls: 'info', icon: 'bi-graph-up', text: d.totalBookingsAllTime + ' lifetime bookings' });
        if (!insightList.length) insightList.push({ cls: 'success', icon: 'bi-check-circle', text: 'All systems running smoothly' });

        chips.innerHTML = insightList.map(function(c) {
          return '<span class="exec-insight-chip ' + c.cls + '"><i class="bi ' + c.icon + '"></i> ' + c.text + '</span>';
        }).join('');
      }
    })();

    // ── Customer Insights ──
    (function() {
      var body = $('customerInsightsBody');
      if (!body) return;
      var totalC = d.totalCustomers || 0;
      var newC = d.newCustomersThisMonth || 0;
      var vip = d.vipCustomers || 0;
      var growthPct = totalC > 0 ? Math.round((newC / totalC) * 100) : 0;
      body.innerHTML =
        '<div class="dash-stat-grid" style="margin-bottom:14px;">' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#3b82f6;">' + totalC + '</div><div class="dash-stat-card-lbl">Total</div></div>' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#10b981;">+' + newC + '</div><div class="dash-stat-card-lbl">New</div><div class="dash-stat-card-sub">' + growthPct + '%</div></div>' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#8b5cf6;">' + vip + '</div><div class="dash-stat-card-lbl">VIP</div></div>' +
        '</div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Total Customers</span><span class="dash-list-value">' + totalC + '</span></div>' +
        '<div class="dash-list-row"><span class="dash-list-label">New This Month</span><span class="dash-list-value" style="color:#059669;">+' + newC + '</span></div>' +
        '<div class="dash-list-row"><span class="dash-list-label">VIP Customers</span><span class="dash-list-value" style="color:#8b5cf6;">' + vip + '</span></div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Avg. Rating</span><span class="dash-list-value" style="color:#f59e0b;">' + (d.avgRating || '--') + ' ★ <span style="font-size:0.7rem;color:#94a3b8;font-weight:500;">(' + (d.totalRatings || 0) + ')</span></span></div>';
    })();

    // ── Large-Scale Projects ──
    (function() {
      var body = $('projectInsightsBody');
      if (!body) return;
      var total = d.totalProjects || 0;
      var active = d.activeProjects || 0;
      var completed = d.completedProjects || 0;
      var pctComplete = total > 0 ? Math.round((completed / total) * 100) : 0;
      var activePct = total > 0 ? Math.round((active / total) * 100) : 0;
      body.innerHTML =
        '<div class="dash-stat-grid" style="margin-bottom:14px;">' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#0f172a;">' + total + '</div><div class="dash-stat-card-lbl">Total</div></div>' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#059669;">' + active + '</div><div class="dash-stat-card-lbl">Active</div><div class="dash-stat-card-sub">' + activePct + '%</div></div>' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#3b82f6;">' + completed + '</div><div class="dash-stat-card-lbl">Completed</div></div>' +
        '</div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Total Projects</span><span class="dash-list-value">' + total + '</span></div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Active Projects</span><span class="dash-list-value" style="color:#059669;">' + active + '</span></div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Completed</span><span class="dash-list-value" style="color:#3b82f6;">' + completed + '</span></div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Completion Rate</span><span class="dash-list-value" style="color:#8b5cf6;">' + pctComplete + '%</span></div>';
    })();

    // ── Team Performance ──
    (function() {
      var body = $('teamPerfBody');
      if (!body) return;
      var total = d.totalTechnicians || 0;
      var avail = d.availableTechnicians || 0;
      var busy = d.busyTechnicians || 0;
      var absent = d.absentTechnicians || 0;
      var utilRate = total > 0 ? Math.round((busy / total) * 100) : 0;
      var availRate = total > 0 ? Math.round((avail / total) * 100) : 0;
      body.innerHTML =
        '<div class="dash-stat-grid" style="margin-bottom:14px;">' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#0f172a;">' + total + '</div><div class="dash-stat-card-lbl">Total</div></div>' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#10b981;">' + avail + '</div><div class="dash-stat-card-lbl">Available</div><div class="dash-stat-card-sub">' + availRate + '%</div></div>' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#f59e0b;">' + busy + '</div><div class="dash-stat-card-lbl">Busy</div><div class="dash-stat-card-sub">' + utilRate + '%</div></div>' +
        '</div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Total Technicians</span><span class="dash-list-value">' + total + '</span></div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Available Now</span><span class="dash-list-value" style="color:#10b981;">' + avail + ' <span style="font-size:0.7rem;color:#94a3b8;font-weight:500;">(' + availRate + '%)</span></span></div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Busy / Assigned</span><span class="dash-list-value" style="color:#f59e0b;">' + busy + ' <span style="font-size:0.7rem;color:#94a3b8;font-weight:500;">(' + utilRate + '%)</span></span></div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Offline / Absent</span><span class="dash-list-value" style="color:#64748b;">' + absent + '</span></div>';
    })();

    // ── Expense Summary ──
    (function() {
      var body = $('expenseBody');
      if (!body) return;
      var cur = d.revenueCurrency || 'PHP';
      var pendCount = d.pendingExpenses || 0;
      var pendTotal = d.pendingExpensesTotal || 0;
      var monthExp = d.monthlyExpenses || 0;
      var margin = d.profitMargin || 0;
      var totalFlow = monthExp + pendTotal;
      var pendingPct = totalFlow > 0 ? Math.round((pendTotal / totalFlow) * 100) : 0;
      body.innerHTML =
        '<div class="dash-stat-grid" style="margin-bottom:14px;">' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#0f172a;">' + fmtMoney(monthExp, cur) + '</div><div class="dash-stat-card-lbl">Approved</div></div>' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#f59e0b;">' + pendCount + '</div><div class="dash-stat-card-lbl">Pending</div><div class="dash-stat-card-sub">' + pendingPct + '%</div></div>' +
        '<div class="dash-stat-card"><div class="dash-stat-card-val" style="color:#ef4444;">' + fmtMoney(pendTotal, cur) + '</div><div class="dash-stat-card-lbl">Pending ₱</div></div>' +
        '</div>' +
        '<div class="dash-list-row"><span class="dash-list-label">This Month (Approved)</span><span class="dash-list-value" style="color:#0f172a;">' + fmtMoney(monthExp, cur) + '</span></div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Pending Approval</span><span class="dash-list-value" style="color:#f59e0b;">' + pendCount + '</span></div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Pending Total</span><span class="dash-list-value" style="color:#ef4444;">' + fmtMoney(pendTotal, cur) + '</span></div>' +
        '<div class="dash-list-row"><span class="dash-list-label">Profit Margin</span><span class="dash-list-value" style="color:' + (margin >= 20 ? '#059669' : '#d97706') + ';">' + (d.profitMargin != null ? d.profitMargin + '%' : '--') + '</span></div>';
    })();

    // ── Notifications ──
    (function() {
      var body = $('notificationsBody');
      var meta = $('notifCount');
      if (!body) return;
      var notes = (d.notifications || []).slice();
      var lowItems = d.lowStockItems || [];
      lowItems.slice(0, 3).forEach(function(it) {
        notes.push({ type: 'danger', icon: 'bi-exclamation-triangle-fill', message: 'Low stock: ' + (it.name || it.title || 'Item') + ' (' + (it.quantity != null ? it.quantity : it.stock != null ? it.stock : 0) + ' left)' });
      });
      if (meta) meta.innerHTML = '<span class="dash-chip ' + (notes.length ? (notes[0].type === 'danger' ? 'danger' : 'warning') : 'success') + '"><i class="bi ' + (notes.length ? 'bi-bell-fill' : 'bi-check-circle') + '"></i> ' + notes.length + ' alert' + (notes.length !== 1 ? 's' : '') + '</span>';
      if (!notes.length) { body.innerHTML = '<div class="dash-empty">No notifications</div>'; return; }
      body.innerHTML = notes.map(function(n) {
        var bg = n.type === 'danger' ? 'rgba(239,68,68,0.10)' : n.type === 'warning' ? 'rgba(245,158,11,0.10)' : 'rgba(59,130,246,0.10)';
        var fg = n.type === 'danger' ? '#dc2626' : n.type === 'warning' ? '#d97706' : '#2563eb';
        return '<div class="notif-item" style="border-radius:10px;padding:10px;background:' + bg + ';margin-bottom:6px;">' +
          '<div class="notif-icon" style="background:#fff;color:' + fg + ';"><i class="bi ' + (n.icon || 'bi-info-circle') + '"></i></div>' +
          '<div style="font-size:0.82rem;font-weight:600;color:#475569;">' + (n.message || '') + '</div></div>';
      }).join('');
    })();

    // ── Aircon Inventory ──
    (function() {
      var s = d.inventoryStats || {};
      // Mini stats
      setText('inv-total-products', s.totalProducts != null ? s.totalProducts : '--');
      setText('inv-total-units', s.totalUnits != null ? s.totalUnits : '--');
      setText('inv-total-value', s.totalValue != null ? fmtMoney(s.totalValue, 'PHP') : '--');
      setText('inv-lowstock-count', s.lowStock != null ? (s.lowStock + (s.outOfStock != null ? ' / ' + s.outOfStock : '')) : '--');

      // Inventory status chips
      var low = s.lowStock || 0;
      var out = s.outOfStock || 0;
      var statusCls = low > 0 || out > 0 ? 'warning' : 'success';
      var sub = $('inv-lowstock-sub');
      if (sub) sub.innerHTML = '<span class="dash-chip ' + statusCls + '" style="font-size:0.62rem;padding:2px 8px;"><i class="bi ' + (statusCls === 'success' ? 'bi-check-circle' : 'bi-exclamation-triangle') + '"></i> ' + (low + out) + ' item' + ((low + out) !== 1 ? 's' : '') + ' need attention</span>';
      var trend = $('inv-lowstock-trend');
      if (trend) trend.className = 'kpi-trend ' + (statusCls === 'success' ? 'up' : 'down');
      if (trend) trend.innerHTML = '<i class="bi ' + (statusCls === 'success' ? 'bi-check' : 'bi-exclamation-circle') + '"></i> ' + (statusCls === 'success' ? 'OK' : 'Alert');

      // Top products
      var body = $('topProductsBody');
      if (!body) return;
      var products = d.topProducts || [];
      if (!products.length) { body.innerHTML = '<div class="dash-empty">No products in inventory</div>'; return; }
      body.innerHTML = '<div class="inv-prod-grid">' + products.map(function(p) {
        var imgSrc = p.imageUrl && p.imageUrl !== '/images/products/default.png' ? p.imageUrl : null;
        var statusText = statusLabel(p.status) || p.status || 'Unknown';
        var stCls = (p.status === 'in_stock' ? 'in-stock' : p.status === 'low_stock' ? 'low-stock' : p.status === 'out_of_stock' ? 'out-of-stock' : 'coming-soon');
        return '<div class="inv-prod-card">' +
          (p.inverter ? '<div class="inv-prod-inverter"><i class="bi bi-lightning-fill me-1"></i>Inverter</div>' : '') +
          '<div class="inv-prod-img">' +
          (imgSrc ? '<img src="' + imgSrc + '" alt="' + (p.displayLabel || '') + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\';" />' : '') +
          '<div class="fallback-icon" style="display:' + (imgSrc ? 'none' : 'flex') + ';align-items:center;justify-content:center;width:100%;height:100%;"><i class="bi bi-box-seam"></i></div>' +
          '</div>' +
          '<div class="inv-prod-body">' +
          '<div class="inv-prod-name" title="' + (p.displayLabel || '') + '">' + (p.displayLabel || 'Aircon') + '</div>' +
          '<div class="inv-prod-meta">Stock: ' + (p.quantity != null ? p.quantity : 0) + ' units</div>' +
          '<div class="inv-prod-footer">' +
          '<span class="inv-prod-price">' + fmtMoney(p.sellingPrice, 'PHP') + '</span>' +
          '<span class="inv-prod-badge ' + stCls + '">' + statusText + '</span>' +
          '</div></div></div>';
      }).join('') + '</div>';
    })();

    // ── Insights Summary ──
    (function() {
      var grid = $('insightsGrid');
      var ts = $('insightsTimestamp');
      if (!grid) return;
      if (ts) ts.textContent = new Date().toLocaleString('en', { hour: '2-digit', minute: '2-digit', hour12: true }) + ' — Auto-generated';

      var insights = [];

      // Bookings insight
      var todayBookings = d.totalBookingsToday || 0;
      var allBookings = d.totalBookingsAllTime || 0;
      var completedToday = d.completedToday || 0;
      var trend7 = d.trend7 || [];
      var weekTotal = trend7.reduce(function(s, t) { return s + (t.count || 0); }, 0);
      var avgPerDay = trend7.length ? Math.round(weekTotal / trend7.length) : 0;

      if (todayBookings > 0) {
        var change = avgPerDay > 0 ? Math.round(((todayBookings - avgPerDay) / avgPerDay) * 100) : 0;
        insights.push({
          type: change > 0 ? 'success' : change < -30 ? 'warning' : 'info',
          icon: change > 0 ? 'bi-arrow-up-short' : change < 0 ? 'bi-arrow-down-short' : 'bi-dash',
          title: todayBookings + ' bookings today' + (change !== 0 ? ' (' + (change > 0 ? '+' : '') + change + '% vs avg)' : ''),
          text: '7-day average is ' + avgPerDay + ' bookings/day (' + weekTotal + ' this week).',
          action: '/admin/appointments', actionLabel: 'View Bookings'
        });
      } else if (allBookings > 0) {
        insights.push({ type: 'info', icon: 'bi-calendar3', title: 'No bookings scheduled for today', text: 'You have ' + allBookings + ' total bookings on record. Average ' + avgPerDay + '/day this week.', action: '/admin/appointments', actionLabel: 'View Schedule' });
      }

      // Pending review
      var pendingReview = d.pendingReview || 0;
      if (pendingReview > 0) {
        insights.push({ type: 'warning', icon: 'bi-clock-history', title: pendingReview + ' booking' + (pendingReview > 1 ? 's' : '') + ' awaiting payment review', text: 'Payments need verification before work can proceed. Review promptly to keep jobs on schedule.', action: '/admin/payments', actionLabel: 'Review Payments' });
      }

      // Awaiting assignment
      var awaitAssign = d.awaitingAssignment || 0;
      var availTechs = d.availableTechnicians || 0;
      if (awaitAssign > 0) {
        insights.push({
          type: availTechs > 0 ? 'info' : 'danger',
          icon: 'bi-person-plus',
          title: awaitAssign + ' booking' + (awaitAssign > 1 ? 's' : '') + ' awaiting technician assignment',
          text: availTechs > 0 ? availTechs + ' technician' + (availTechs > 1 ? 's' : '') + ' available for assignment.' : 'No technicians currently available. Consider rebalancing workload.',
          action: '/admin/technicians', actionLabel: 'Assign Techs'
        });
      }

      // Active services
      var activeS = d.activeServices || 0;
      var busyTechs = d.busyTechnicians || 0;
      if (activeS > 0) {
        var utilization = d.totalTechnicians > 0 ? Math.round((busyTechs / d.totalTechnicians) * 100) : 0;
        insights.push({
          type: utilization > 80 ? 'warning' : 'success',
          icon: 'bi-tools',
          title: activeS + ' active service' + (activeS > 1 ? 's' : '') + ' in progress',
          text: 'Technician utilization at ' + utilization + '% (' + busyTechs + '/' + (d.totalTechnicians || 0) + ' busy).',
          action: '/admin/jobs/active', actionLabel: 'View Active Jobs'
        });
      }

      // Revenue insight
      var revenueToday = d.revenueToday || 0;
      var monthlyRevenue = d.monthlyRevenue || 0;
      var lastMonthRevenue = d.lastMonthRevenue || 0;
      var pendingPayments = d.pendingPayments || 0;
      if (revenueToday > 0 || monthlyRevenue > 0) {
        var revChange = lastMonthRevenue > 0 ? Math.round(((monthlyRevenue - lastMonthRevenue) / lastMonthRevenue) * 100) : 0;
        var msg = 'Today: ' + fmtMoney(revenueToday) + '. Monthly: ' + fmtMoney(monthlyRevenue) + '.';
        if (revChange !== 0) msg += ' ' + (revChange > 0 ? '+' : '') + revChange + '% vs last month.';
        if (pendingPayments > 0) msg += ' ' + fmtMoney(pendingPayments) + ' pending collection.';
        insights.push({
          type: revChange > 0 ? 'success' : revChange < -10 ? 'danger' : 'info',
          icon: 'bi-cash-coin',
          title: 'Revenue performance',
          text: msg,
          action: '/admin/payments', actionLabel: 'View Payments'
        });
      }

      // Low stock
      var lowStock = d.lowStockCount || 0;
      if (lowStock > 0) {
        var items = (d.lowStockItems || []).slice(0, 3).map(function(i) { return i.name || i.productName || 'Item'; }).join(', ');
        insights.push({
          type: 'danger', icon: 'bi-exclamation-triangle',
          title: lowStock + ' item' + (lowStock > 1 ? 's' : '') + ' low on stock',
          text: (items ? items + (lowStock > 3 ? ' and more' : '') + ' — ' : '') + 'Reorder soon to avoid service delays.',
          action: '/admin/inventory', actionLabel: 'Check Inventory'
        });
      }

      // Pending expenses
      var pendExp = d.pendingExpenses || 0;
      if (pendExp > 0) {
        insights.push({
          type: 'warning', icon: 'bi-receipt',
          title: pendExp + ' expense' + (pendExp > 1 ? 's' : '') + ' pending approval',
          text: fmtMoney(d.pendingExpensesTotal || 0) + ' total awaiting your review.',
          action: '/admin/expenses', actionLabel: 'Review Expenses'
        });
      }

      // Technician availability
      var totalTechs = d.totalTechnicians || 0;
      var absentTechs = d.absentTechnicians || 0;
      if (totalTechs > 0 && absentTechs > totalTechs * 0.4) {
        insights.push({
          type: 'warning', icon: 'bi-person-x',
          title: absentTechs + ' of ' + totalTechs + ' technicians offline',
          text: Math.round((absentTechs / totalTechs) * 100) + '% of workforce unavailable. May impact service capacity.',
          action: '/admin/technicians', actionLabel: 'Manage Team'
        });
      }

      // Default insight if nothing else
      if (!insights.length) {
        insights.push({ type: 'success', icon: 'bi-check-circle', title: 'All systems running smoothly', text: 'No immediate action required. KPIs are within normal range.' });
      }

      grid.innerHTML = insights.map(function(ins) {
        return '<div class="col-xl-4 col-md-6"><div class="insight-item ' + ins.type + '">' +
          '<div class="insight-icon ' + ins.type + '"><i class="bi ' + ins.icon + '"></i></div>' +
          '<div class="insight-text"><strong>' + ins.title + '</strong><p>' + ins.text + '</p></div>' +
          (ins.action ? '<a href="' + ins.action + '" class="insight-action">' + ins.actionLabel + ' &rarr;</a>' : '') +
          '</div></div>';
      }).join('');
    })();
  }

  // ── Boot ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadDashboard);
  } else {
    loadDashboard();
  }
})();