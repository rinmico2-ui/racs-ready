(function () {
  "use strict";

  var root = document.querySelector("[data-report-center]");
  if (!root) return;
  var reportRole = root.getAttribute("data-report-role") === "secretary" ? "secretary" : "admin";

  var refreshButton = document.getElementById("refreshReportCenter");
  var state = document.getElementById("reportCenterState");
  var freshness = document.getElementById("reportFreshness");
  var requestController = null;
  var overviewLoaded = false;
  var activeTab = null;
  var tabButtons = Array.from(root.querySelectorAll("[data-report-tab]"));
  var peso = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", maximumFractionDigits: 0 });

  function setText(id, value) {
    var element = document.getElementById(id);
    if (!element) return;
    element.textContent = value;
    element.classList.remove("is-loading");
  }

  function setState(message, tone) {
    state.className = "rc-state" + (tone ? " " + tone : "");
    state.replaceChildren();
    var icon = document.createElement("i");
    icon.className = tone === "error" ? "bi bi-exclamation-circle" : "bi bi-info-circle";
    icon.setAttribute("aria-hidden", "true");
    var label = document.createElement("span");
    label.textContent = message;
    state.append(icon, label);
    state.hidden = false;
  }

  function setFreshness(label, tone) {
    freshness.className = "rc-live-status " + (tone || "");
    var dot = document.createElement("span");
    dot.className = "rc-live-dot";
    freshness.replaceChildren(dot, document.createTextNode(label));
  }

  function renderInsights(insights) {
    var host = document.getElementById("rcInsights");
    host.replaceChildren();
    (insights || []).forEach(function (insight) {
      var item = document.createElement("a");
      item.className = "rc-insight " + (insight.tone || "info");
      var destination = insight.href || "/admin/reports";
      if (reportRole === "secretary") destination = destination.replace(/^\/admin\//, "/secretary/");
      item.href = destination;
      var icon = document.createElement("span");
      icon.className = "rc-insight-icon";
      icon.innerHTML = '<i class="bi bi-' + (insight.tone === "danger" ? "exclamation-octagon" : insight.tone === "warning" ? "exclamation-triangle" : insight.tone === "success" ? "check2-circle" : "lightbulb") + '"></i>';
      var copy = document.createElement("span");
      var title = document.createElement("strong");
      var text = document.createElement("p");
      title.textContent = insight.title || "Suggested next step";
      text.textContent = insight.text || "Open the detailed report for more information.";
      copy.append(title, text);
      item.append(icon, copy);
      host.appendChild(item);
    });
  }

  function render(data) {
    var finance = data.financial || {};
    var operations = data.operations || {};
    var inventory = data.inventory || {};
    setText("rcRevenue", data.financial ? peso.format(finance.monthlyRevenue || 0) : "Unavailable");
    setText("rcCollections", data.financial ? peso.format(finance.netCollections || 0) : "Unavailable");
    setText("rcProfit", data.financial ? peso.format(finance.operatingProfit || 0) : "Unavailable");
    setText("rcOutstanding", data.financial ? peso.format(finance.pendingPayments || 0) : "Unavailable");
    setText("rcBookings", data.operations ? operations.activeBookings || 0 : "Unavailable");
    setText("rcOrders", data.operations ? operations.activeOrders || 0 : "Unavailable");
    setText("rcPaymentActions", data.financial ? finance.paymentActionCount || 0 : "Unavailable");
    setText("rcInventory", data.inventory ? inventory.alerts || 0 : "Unavailable");

    var profit = document.getElementById("rcProfit");
    if (profit) profit.classList.toggle("negative", Number(finance.operatingProfit || 0) < 0);
    setText("rcProfitMeta", data.financial ? Math.round(finance.profitMargin || 0) + "% recorded margin · " + Math.round(finance.costDataCoverage || 0) + "% known-sales with saved costs" : "Financial source unavailable");
    setText("rcPaymentActionsMeta", data.financial ? (finance.pendingLedgerCount || 0) + " waiting for a check · " + (finance.paymentExceptionCount || 0) + " issues to check" : "Payment records could not load");
    setText("rcInventoryMeta", data.inventory ? (inventory.outOfStock || 0) + " out · " + (inventory.lowStock || 0) + " low · " + (inventory.skuCount || 0) + " active item types" : "Stock records could not load");
    renderInsights(data.insights);

    var updated = new Date(data.asOf);
    var timeLabel = Number.isNaN(updated.getTime()) ? "just now" : updated.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
    var dateTimeLabel = Number.isNaN(updated.getTime()) ? "Latest refresh unavailable" : "Last updated " + updated.toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" }) + " · " + timeLabel;
    setText("rcMethodologyUpdated", dateTimeLabel);
    setText("rcCoverageDefinition", data.financial ? Math.round(finance.costDataCoverage || 0) + "% of completed sales before refunds currently has enough saved cost details to estimate profit." : "Sales with saved costs could not load right now.");
    if (data.financial && finance.periodStart && finance.periodEnd) {
      var periodStart = new Date(finance.periodStart);
      var periodEnd = new Date(finance.periodEnd);
      var startLabel = periodStart.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
      var endLabel = periodEnd.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
      setText("rcReportingPeriod", startLabel + " – " + endLabel + " (current calendar month)");
    } else {
      setText("rcReportingPeriod", "Current reporting period could not load right now.");
    }
    setFreshness((data.partial ? "Partial · " : "Updated ") + timeLabel, data.partial ? "partial" : "ready");
    if (data.partial) setState("Some report sources are temporarily unavailable. Available figures are still shown and clearly separated.", "warning");
    else state.hidden = true;
  }

  async function loadSnapshot() {
    if (requestController) requestController.abort();
    requestController = new AbortController();
    refreshButton.disabled = true;
    refreshButton.querySelector("i").classList.add("rc-spin");
    try {
      var response = await fetch("/api/" + reportRole + "/reports/overview", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: requestController.signal,
      });
      if (response.status === 401) {
        window.location.assign("/login?returnTo=" + encodeURIComponent(window.location.pathname));
        return;
      }
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(payload.error || "Unable to load the report summary.");
      render(payload);
      overviewLoaded = true;
    } catch (error) {
      if (error.name === "AbortError") return;
      setState(error.message || "Unable to load the report summary. Please retry.", "error");
      setFreshness("Summary could not load", "partial");
    } finally {
      refreshButton.disabled = false;
      refreshButton.querySelector("i").classList.remove("rc-spin");
    }
  }

  function showTab(nextTab, updateHistory) {
    activeTab = nextTab === "decisions" ? "decisions" : "overview";
    tabButtons.forEach(function (button) {
      var selected = button.dataset.reportTab === activeTab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      document.getElementById(button.getAttribute("aria-controls")).hidden = !selected;
    });
    freshness.hidden = activeTab === "decisions";
    refreshButton.setAttribute("aria-label", activeTab === "decisions" ? "Refresh management decisions" : "Refresh overview");
    if (updateHistory) {
      var url = new URL(window.location.href);
      if (activeTab === "decisions") url.searchParams.set("tab", "decisions");
      else url.searchParams.delete("tab");
      window.history.pushState({ reportTab: activeTab }, "", url);
    }
    if (activeTab === "decisions") document.dispatchEvent(new Event("reportcenter:decisions"));
    else if (!overviewLoaded) loadSnapshot();
  }

  tabButtons.forEach(function (button, index) {
    button.addEventListener("click", function () { showTab(button.dataset.reportTab, true); });
    button.addEventListener("keydown", function (event) {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      var next = event.key === "Home" ? 0 : event.key === "End" ? tabButtons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabButtons.length) % tabButtons.length;
      tabButtons[next].focus();
      showTab(tabButtons[next].dataset.reportTab, true);
    });
  });
  window.addEventListener("popstate", function () {
    showTab(new URLSearchParams(window.location.search).get("tab"), false);
  });
  refreshButton.addEventListener("click", function () {
    if (activeTab === "decisions") document.dispatchEvent(new Event("reportcenter:decisions-refresh"));
    else loadSnapshot();
  });
  showTab(root.dataset.initialTab, false);
})();
