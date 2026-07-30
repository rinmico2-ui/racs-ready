(function () {
  'use strict';

  /* ── Shared Technician Helpers ────────────────────────────── */

  var statusConfig = {
    pending_payment: { label: 'Pending Payment', color: 'secondary' },
    preparing_unit: { label: 'Preparing Unit', color: 'secondary' },
    technician_assigned: { label: 'Assigned', color: 'primary' },
    out_for_delivery: { label: 'Out for Delivery', color: 'info' },
    arrived: { label: 'Arrived', color: 'primary' },
    installing: { label: 'Installing', color: 'warning' },
    completed: { label: 'Completed', color: 'success' },
    cancelled: { label: 'Cancelled', color: 'danger' },
    pending: { label: 'Pending', color: 'warning' },
    confirmed: { label: 'Confirmed', color: 'info' },
    scheduled: { label: 'Scheduled', color: 'primary' },
    'on-the-way': { label: 'On The Way', color: 'info' },
    'in-progress': { label: 'In Progress', color: 'warning' },
    're-scheduled': { label: 'Re-scheduled', color: 'secondary' },
  };

  window.techHelpers = {
    formatDate: function (d) {
      if (!d) return '\u2014';
      var date = new Date(d);
      return date.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
    },

    formatTime: function (d) {
      if (!d) return '\u2014';
      var date = new Date(d);
      if (isNaN(date.getTime())) return d;
      return date.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
    },

    formatPeso: function (n) {
      if (n == null || isNaN(n)) return '\u20b10';
      return '\u20b1' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },

    normalizeStatus: function (s) {
      if (!s) return 'pending';
      var map = { pending: 'pending', confirmed: 'confirmed', scheduled: 'scheduled', 'on-the-way': 'on-the-way', 'in-progress': 'in-progress', completed: 'completed', cancelled: 'cancelled', 're-scheduled': 're-scheduled', pending_payment: 'pending_payment', preparing_unit: 'preparing_unit', technician_assigned: 'technician_assigned', out_for_delivery: 'out_for_delivery', arrived: 'arrived', installing: 'installing' };
      return map[s] || s;
    },

    badgeClass: function (s) {
      var c = statusConfig[s];
      return c ? c.color : 'secondary';
    },

    statusBadge: function (s) {
      var cfg = statusConfig[s] || { label: s, color: 'secondary' };
      return '<span class="badge bg-' + cfg.color + '">' + cfg.label + '</span>';
    },

    getCustomerLabel: function (a) {
      if (!a) return 'Unknown';
      var name = (a.customer && a.customer.name) || a.customerName || '';
      var firstName = a.firstName || (a.userId && a.userId.firstName) || '';
      var lastName = a.lastName || (a.userId && a.userId.lastName) || '';
      return name || (firstName + ' ' + lastName).trim() || 'Customer';
    },

    payMethodBadge: function (m) {
      if (!m) return '<span class="badge bg-secondary">\u2014</span>';
      var map = { cod: 'success', gcash: 'info', gcash_full: 'info', gcash_downpayment: 'info', paymongo: 'info', cash_onsite: 'success', cash: 'success', downpayment: 'warning', other: 'secondary' };
      var color = map[m] || 'secondary';
      return '<span class="badge bg-' + color + ' text-uppercase">' + m.replace(/_/g, ' ') + '</span>';
    },

    renderSparkline: function (canvasId, data, color) {
      var canvas = document.getElementById(canvasId);
      if (!canvas || typeof Chart === 'undefined') return;
      if (canvas._chart) { canvas._chart.destroy(); }
      var ctx = canvas.getContext('2d');
      canvas._chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: data.map(function (_, i) { return i; }),
          datasets: [{
            data: data,
            borderColor: color || '#3b82f6',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.4,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: { x: { display: false }, y: { display: false } },
          elements: { point: { radius: 0 } },
        },
      });
    },
  };
})();
