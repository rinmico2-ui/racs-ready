/* ═══════════════════════════════════════════════════════════════
   ChartDrilldown — Enterprise Chart Click-through System
   Usage: ChartDrilldown.open({ title, chartConfig, details, filters, summary })
   ═══════════════════════════════════════════════════════════════ */

var ChartDrilldown = (function () {
  'use strict';

  var _chartInstance = null;
  var _config = null;
  var _activeFilter = null;
  var _requestVersion = 0;

  /* ── DOM helpers ── */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  /* ── Public API ── */
  function open(cfg) {
    _config = cfg;
    _activeFilter = null;
    _requestVersion += 1;

    // Title + subtitle
    $('cdmTitle').textContent = cfg.title || 'Chart Details';
    $('cdmSubtitle').textContent = cfg.subtitle || 'Click any slice or bar to filter the details below';
    if ($('cdmSelectionLabel')) $('cdmSelectionLabel').textContent = cfg.selectionLabel || 'All records';
    if ($('cdmDataHeading')) $('cdmDataHeading').textContent = cfg.dataHeading || 'Selection details';
    if ($('cdmLiveBadge')) $('cdmLiveBadge').hidden = typeof cfg.loadDetails !== 'function';

    // Render chart into modal
    renderChart(cfg.chartConfig);

    // Render filter chips
    renderFilters(cfg.filters || [], cfg.filterField, cfg.details || []);

    // Render detail table
    renderTable(cfg.details || [], cfg.columns, null);

    // Render summary stats
    renderSummary(cfg.summary || {});

    // Bind export
    $('cdmExportBtn').onclick = function () { exportCSV(_config.details || [], _config.columns, _activeFilter, _config.filterField, _config.title); };

    // Show modal
    var modalEl = $('cdmChartDrilldown') || $('chartDrilldownModal');
    if (!modalEl) return;
    if (modalEl.parentNode !== document.body) document.body.appendChild(modalEl);
    modalEl.style.zIndex = '12000';
    var bsModal = new bootstrap.Modal(modalEl, { backdrop: true, keyboard: true, focus: true });
    bsModal.show();

    if (typeof cfg.loadDetails === 'function') {
      loadDetails(cfg.loadDetails, cfg.selectionLabel);
    } else {
      setViewState('ready');
    }

    // Cleanup on close
    modalEl.addEventListener('hidden.bs.modal', function handler() {
      _requestVersion += 1;
      destroyChart();
      _config = null;
      bsModal.dispose();
      modalEl.removeEventListener('hidden.bs.modal', handler);
    });
  }

  /* ── Chart rendering ── */
  function renderChart(chartCfg) {
    destroyChart();
    if (!chartCfg || typeof Chart === 'undefined') return;

    var canvas = $('cdmChartCanvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');

    // Functions and canvas gradients cannot be serialized into the modal.
    // Use solid semantic fallbacks while preserving the source data and axes.
    var cfg = JSON.parse(JSON.stringify(chartCfg, function (key, value) {
      if (typeof value === 'function') return undefined;
      if ((key === 'backgroundColor' || key === 'borderColor') && value && typeof value === 'object' && !Array.isArray(value)) return undefined;
      return value;
    }));

    // Apply enterprise defaults
    if (!cfg.options) cfg.options = {};
    cfg.options.responsive = true;
    cfg.options.maintainAspectRatio = false;
    cfg.options.animation = { duration: 800, easing: 'easeOutQuart' };

    if (!cfg.options.plugins) cfg.options.plugins = {};
    cfg.options.plugins.legend = Object.assign({ display: true, position: 'bottom' }, cfg.options.plugins.legend || {});
    cfg.options.plugins.legend.display = true;
    cfg.options.plugins.legend.position = 'bottom';
    cfg.options.plugins.legend.labels = Object.assign({ padding: 16, usePointStyle: true, pointStyleWidth: 10, boxWidth: 8, font: { size: 11, weight: '600', family: 'Inter, system-ui, sans-serif' } }, cfg.options.plugins.legend.labels || {});
    cfg.options.plugins.tooltip = Object.assign({ backgroundColor: 'rgba(15,23,42,0.92)', titleFont: { size: 12, weight: '700' }, bodyFont: { size: 11 }, padding: 12, cornerRadius: 8, displayColors: true, boxPadding: 4 }, cfg.options.plugins.tooltip || {});

    // Ensure datasets have proper colors for line charts
    if (cfg.type === 'line' && cfg.data && cfg.data.datasets) {
      cfg.data.datasets.forEach(function (ds, index) {
        if (!ds.borderWidth) ds.borderWidth = 2.5;
        if (ds.tension === undefined) ds.tension = 0.4;
        if (!ds.borderColor) ds.borderColor = palette(index + 1)[index];
        if (!ds.backgroundColor) ds.backgroundColor = hexToAlpha(ds.borderColor, 0.12);
      });
    }

    // Ensure doughnut/pie have proper cutout
    if ((cfg.type === 'doughnut' || cfg.type === 'pie') && cfg.options) {
      if (cfg.options.cutout === undefined) cfg.options.cutout = '65%';
    }

    cfg.options.onHover = function (event, elements) {
      if (event.native && event.native.target) event.native.target.style.cursor = elements.length && typeof _config.onChartSelect === 'function' ? 'pointer' : 'default';
    };
    cfg.options.onClick = function (event, elements) {
      if (!elements.length || typeof _config.onChartSelect !== 'function') return;
      var element = elements[0];
      var label = cfg.data.labels[element.index];
      var dataset = cfg.data.datasets[element.datasetIndex] || {};
      var selection = { index: element.index, datasetIndex: element.datasetIndex, label: label, datasetLabel: dataset.label || '' };
      _chartInstance.setActiveElements([{ datasetIndex: element.datasetIndex, index: element.index }]);
      _chartInstance.update();
      loadDetails(function () { return _config.onChartSelect(selection); }, String(label) + (dataset.label ? ' / ' + dataset.label : ''));
    };

    _chartInstance = new Chart(ctx, cfg);
    if (_config.selectedElement && Number.isInteger(_config.selectedElement.index)) {
      _chartInstance.setActiveElements([{ datasetIndex: _config.selectedElement.datasetIndex || 0, index: _config.selectedElement.index }]);
      _chartInstance.update();
    }
  }

  function setViewState(state, message) {
    var loading = $('cdmLoadingState');
    var error = $('cdmErrorState');
    var table = $('cdmTableWrap');
    var filters = $('cdmFilterBar');
    var exportButton = $('cdmExportBtn');
    var summary = $('cdmSummaryBar');
    if (loading) loading.hidden = state !== 'loading';
    if (error) error.hidden = state !== 'error';
    if (table) table.hidden = state === 'loading' || state === 'error';
    if (filters && state !== 'ready') filters.style.display = 'none';
    if (exportButton) exportButton.disabled = state !== 'ready';
    if (summary) summary.hidden = state !== 'ready';
    if (state !== 'ready' && $('cdmHeaderRowCount')) $('cdmHeaderRowCount').textContent = '';
    if (state === 'error' && $('cdmErrorMessage')) $('cdmErrorMessage').textContent = message || 'Please try the selection again.';
  }

  async function loadDetails(loader, selectionLabel) {
    var requestId = ++_requestVersion;
    if ($('cdmSelectionLabel')) $('cdmSelectionLabel').textContent = selectionLabel || 'Selected records';
    setViewState('loading');
    try {
      var payload = await loader();
      if (requestId !== _requestVersion || !_config) return;
      var details = payload && (payload.rows || payload.details) ? (payload.rows || payload.details) : [];
      _config.details = details;
      renderFilters(_config.filters || [], _config.filterField, details);
      renderTable(details, _config.columns, null);
      renderSummary(payload && payload.summary ? payload.summary : (_config.summary || {}));
      setViewState('ready');
    } catch (error) {
      if (requestId !== _requestVersion) return;
      setViewState('error', error && error.message ? error.message : 'Please try the selection again.');
    }
  }

  function destroyChart() {
    if (_chartInstance) {
      _chartInstance.destroy();
      _chartInstance = null;
    }
  }

  /* ── Filter chips ── */
  function renderFilters(filters, filterField, details) {
    var container = $('cdmFilterChips');
    if (!container) return;
    container.innerHTML = '';

    if (!filters || filters.length === 0) {
      var bar = $('cdmFilterBar');
      if (bar) bar.style.display = 'none';
      return;
    }
    var bar = $('cdmFilterBar');
    if (bar) bar.style.display = '';

    // "All" chip
    var total = details.length;
    var allChip = el('button', 'cdm-chip active', 'All <span class="cdm-chip-count">' + total + '</span>');
    allChip.type = 'button';
    allChip.dataset.filter = '';
    allChip.onclick = function () {
      _activeFilter = null;
      setActiveChip(container, allChip);
      renderTable(details, _config.columns, null);
      highlightChartSlice(null);
    };
    container.appendChild(allChip);

    // Per-filter chips
    filters.forEach(function (f) {
      var count = details.filter(function (d) { return d[filterField] === f.key; }).length;
      var chip = el('button', 'cdm-chip', escapeHtml(f.label) + ' <span class="cdm-chip-count">' + count + '</span>');
      chip.type = 'button';
      chip.dataset.filter = f.key;
      chip.style.borderColor = f.color || '';
      chip.onclick = function () {
        _activeFilter = f.key;
        setActiveChip(container, chip);
        renderTable(details, _config.columns, f.key);
        highlightChartSlice(f.key);
      };
      container.appendChild(chip);
    });
  }

  function setActiveChip(container, activeChip) {
    var chips = container.querySelectorAll('.cdm-chip');
    chips.forEach(function (c) { c.classList.remove('active'); });
    activeChip.classList.add('active');
  }

  /* ── Chart slice highlighting ── */
  function highlightChartSlice(filterKey) {
    if (!_chartInstance || !_config) return;
    var chartType = _config.chartConfig.type;

    if (chartType === 'doughnut' || chartType === 'pie' || chartType === 'polarArea') {
      // Dim non-matching slices
      var meta = _chartInstance.getDatasetMeta(0);
      if (!meta || !meta.data) return;

      if (filterKey === null) {
        // Reset all opacity
        meta.data.forEach(function (arc, i) {
          var origAlpha = (_config.chartConfig.data.datasets[0].backgroundColor && _config.chartConfig.data.datasets[0].backgroundColor[i])
            ? hexToAlpha(_config.chartConfig.data.datasets[0].backgroundColor[i], 1) : 1;
          _chartInstance.data.datasets[0].backgroundColor[i] = origAlpha;
        });
      } else {
        var filterIndex = _config.filters.findIndex(function (f) { return f.key === filterKey; });
        meta.data.forEach(function (arc, i) {
          var origColor = (_config.chartConfig.data.datasets[0].backgroundColor && _config.chartConfig.data.datasets[0].backgroundColor[i])
            ? _config.chartConfig.data.datasets[0].backgroundColor[i] : '#2563eb';
          if (i === filterIndex) {
            _chartInstance.data.datasets[0].backgroundColor[i] = origColor;
          } else {
            _chartInstance.data.datasets[0].backgroundColor[i] = hexToAlpha(origColor, 0.25);
          }
        });
      }
      _chartInstance.update();
    } else if (chartType === 'bar') {
      // Dim non-matching bars
      var ds = _chartInstance.data.datasets[0];
      if (!ds) return;
      var origBg = _config.chartConfig.data.datasets[0].backgroundColor;
      if (!Array.isArray(origBg)) return;

      if (filterKey === null) {
        ds.backgroundColor = origBg.slice();
      } else {
        var fIdx = _config.filters.findIndex(function (f) { return f.key === filterKey; });
        ds.backgroundColor = origBg.map(function (c, i) {
          return i === fIdx ? c : hexToAlpha(c, 0.25);
        });
      }
      _chartInstance.update();
    }
  }

  /* ── Detail table ── */
  function renderTable(details, columns, filterValue) {
    var tbody = $('cdmTableBody');
    var thead = $('cdmTableHead');
    var countEl = $('cdmRowCount');
    if (!tbody) return;

    // Update header if custom columns provided
    if (columns && columns.length > 0 && thead) {
      thead.innerHTML = '';
      columns.forEach(function (col) {
        var th = document.createElement('th');
        th.textContent = col.label;
        if (col.align === 'right') th.className = 'text-end';
        thead.appendChild(th);
      });
    }

    // Filter
    var filtered = details;
    var filterField = _config ? _config.filterField : null;
    if (filterValue && filterField) {
      filtered = details.filter(function (d) { return d[filterField] === filterValue; });
    }

    tbody.innerHTML = '';
    if (filtered.length === 0) {
      var emptyRow = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = (columns ? columns.length : 2);
      emptyCell.className = 'text-center text-muted py-4';
      emptyCell.innerHTML = '<i class="bi bi-inbox" style="font-size:1.5rem;display:block;margin-bottom:0.5rem;"></i>No data for this filter';
      emptyRow.appendChild(emptyCell);
      tbody.appendChild(emptyRow);
    } else {
      var maxVal = 0;
      filtered.forEach(function (r) {
        var v = typeof r.value === 'number' ? r.value : parseFloat(String(r.value).replace(/[^0-9.-]/g, ''));
        if (!isNaN(v) && v > maxVal) maxVal = v;
      });

      filtered.forEach(function (row) {
        var tr = document.createElement('tr');

        if (columns && columns.length > 0) {
          columns.forEach(function (col) {
            var td = document.createElement('td');
            if (col.align === 'right') td.className = 'text-end';
            var raw = row[col.key];
            if (raw === undefined || raw === null || raw === '') raw = '—';
            if ((col.currency || col.key === 'amount') && typeof raw === 'number') {
              td.textContent = '₱' + raw.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              td.classList.add('cdm-money');
            } else if ((col.date || col.key === 'date') && raw !== '—') {
              var date = new Date(raw);
              td.textContent = isNaN(date.getTime()) ? String(raw) : date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
            } else if (col.key === 'status') {
              var badge = document.createElement('span');
              var normalizedStatus = String(raw).toLowerCase().replace(/_/g, '-');
              var tone = ['completed', 'repair-completed', 'closed'].includes(normalizedStatus) ? 'success'
                : ['cancelled', 'rejected', 'repair-declined', 'no-show'].includes(normalizedStatus) ? 'danger'
                : ['in-progress', 'repair-in-progress', 'inspection-in-progress', 'arrived', 'on-the-way'].includes(normalizedStatus) ? 'info' : 'warning';
              badge.className = 'cdm-status ' + tone;
              badge.textContent = String(raw).replace(/[-_]/g, ' ');
              td.appendChild(badge);
            } else if (col.key === 'payment') {
              var paymentBadge = document.createElement('span');
              paymentBadge.className = 'cdm-payment';
              paymentBadge.textContent = String(raw).replace(/_/g, ' ');
              td.appendChild(paymentBadge);
            } else if (col.key === 'rating') {
              var rating = Number(raw);
              td.textContent = rating > 0 ? rating.toFixed(1) + ' / 5' : '-';
              if (rating > 0) td.classList.add('cdm-rating');
            } else if (col.key === 'reference') {
              var reference = document.createElement('strong');
              reference.className = 'cdm-reference';
              reference.textContent = String(raw);
              td.appendChild(reference);
            } else {
              td.textContent = String(raw).replace(/_/g, ' ');
            }
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
          return;
        }

        // Label cell
        var tdLabel = document.createElement('td');
        tdLabel.innerHTML = '<span class="cdm-row-label">' + escapeHtml(row.label) + '</span>';
        if (row.subtext) {
          tdLabel.innerHTML += '<br><span class="cdm-row-sub">' + escapeHtml(row.subtext) + '</span>';
        }
        tr.appendChild(tdLabel);

        // Value cell
        var tdVal = document.createElement('td');
        tdVal.className = 'text-end';
        var displayVal = typeof row.value === 'number' ? row.value.toLocaleString() : escapeHtml(String(row.value));
        tdVal.innerHTML = '<span class="cdm-row-value">' + displayVal + '</span>';
        tr.appendChild(tdVal);

        // Optional bar
        if (row.barValue !== undefined && maxVal > 0) {
          var barTr = document.createElement('tr');
          var barTd = document.createElement('td');
          barTd.colSpan = columns ? columns.length : 2;
          var pct = Math.round((row.barValue / maxVal) * 100);
          barTd.innerHTML = '<div class="cdm-row-bar"><div class="cdm-row-bar-fill" style="width:' + pct + '%"></div></div>';
          barTr.appendChild(barTd);
          tbody.appendChild(tr);
          tbody.appendChild(barTr);
        } else {
          tbody.appendChild(tr);
        }
      });
    }

    var countText = filtered.length + ' row' + (filtered.length !== 1 ? 's' : '');
    if (countEl) countEl.textContent = countText;
    if ($('cdmHeaderRowCount')) $('cdmHeaderRowCount').textContent = countText;
  }

  /* ── Summary stats ── */
  function renderSummary(summary) {
    var bar = $('cdmSummaryBar');
    if (!bar) return;
    bar.innerHTML = '';
    if (!summary || typeof summary !== 'object') return;

    Object.keys(summary).forEach(function (key) {
      var s = el('div', 'cdm-stat');
      s.innerHTML = '<span class="cdm-stat-value">' + escapeHtml(String(summary[key].value !== undefined ? summary[key].value : summary[key])) + '</span>' +
                     '<span class="cdm-stat-label">' + escapeHtml(summary[key].label || key) + '</span>';
      bar.appendChild(s);
    });
  }

  /* ── CSV export ── */
  function exportCSV(details, columns, activeFilter, filterField, title) {
    var filtered = details;
    if (activeFilter && filterField) {
      filtered = details.filter(function (d) { return d[filterField] === activeFilter; });
    }
    if (filtered.length === 0) return;

    var headers = columns ? columns.map(function (c) { return c.label; }) : ['Item', 'Value'];
    var rows = filtered.map(function (r) {
      if (columns) {
        return columns.map(function (c) { return r[c.key] === undefined || r[c.key] === null ? '' : r[c.key]; });
      }
      return [r.label, r.value];
    });

    var csv = headers.join(',') + '\n' + rows.map(function (row) {
      return row.map(function (cell) {
        var v = String(cell).replace(/"/g, '""');
        return v.indexOf(',') >= 0 || v.indexOf('"') >= 0 ? '"' + v + '"' : v;
      }).join(',');
    }).join('\n');

    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = (title || 'chart-data').replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  /* ── Utilities ── */
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function hexToAlpha(hex, alpha) {
    if (!hex || typeof hex !== 'string') return hex;
    // Handle rgb/rgba
    if (hex.indexOf('rgb') === 0) return hex;
    // Handle hex
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (hex.length === 6) {
      var r = parseInt(hex.substring(0, 2), 16);
      var g = parseInt(hex.substring(2, 4), 16);
      var b = parseInt(hex.substring(4, 6), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }
    return hex;
  }

  /* ── Helper: build details array from simple label/value pairs ── */
  function fromPairs(pairs, opts) {
    opts = opts || {};
    return pairs.map(function (p) {
      var item = {
        label: p[0],
        value: p[1],
        filterKey: opts.filterKey ? p[opts.filterKeyIndex || 0] : undefined
      };
      if (opts.subtext) item.subtext = opts.subtext(p);
      if (opts.barValue !== undefined) item.barValue = typeof opts.barValue === 'function' ? opts.barValue(p) : p[opts.barValueIndex || 1];
      return item;
    });
  }

  /* ── Helper: build filter list from details array ── */
  function buildFilters(details, field, labels) {
    if (!details || !field) return [];
    var seen = {};
    var filters = [];
    details.forEach(function (d) {
      var key = d[field];
      if (key !== undefined && !seen[key]) {
        seen[key] = true;
        filters.push({ key: key, label: (labels && labels[key]) || key });
      }
    });
    return filters;
  }

  /* ── Helper: generate chart colors ── */
  function palette(n) {
    var colors = [
      '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c',
      '#d97706', '#16a34a', '#0891b2', '#6366f1', '#ec4899',
      '#8b5cf6', '#14b8a6', '#f59e0b', '#ef4444', '#3b82f6'
    ];
    var result = [];
    for (var i = 0; i < n; i++) result.push(colors[i % colors.length]);
    return result;
  }

  function paletteAlpha(n, alpha) {
    return palette(n).map(function (c) { return hexToAlpha(c, alpha); });
  }

  /* ── Expose public API ── */
  return {
    open: open,
    fromPairs: fromPairs,
    buildFilters: buildFilters,
    palette: palette,
    paletteAlpha: paletteAlpha,
    escapeHtml: escapeHtml
  };
})();
