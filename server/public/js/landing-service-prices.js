(function () {
  "use strict";
  let cachedPrices;
  let loadedAt = 0;
  let pending;
  const currency = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });
  const tokens = new WeakMap();

  function loadPrices(force) {
    if (pending) return pending;
    if (!force && cachedPrices && Date.now() - loadedAt < 30000) return Promise.resolve(cachedPrices);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    pending = (async () => {
      const response = await fetch("/api/services/landing-prices", {
        credentials: "same-origin", headers: { Accept: "application/json" }, signal: controller.signal,
      });
      if (!response.ok) throw new Error("Pricing unavailable");
      const payload = await response.json();
      if (!payload.prices || typeof payload.prices !== "object") throw new Error("Invalid pricing response");
      cachedPrices = payload.prices;
      loadedAt = Date.now();
      return cachedPrices;
    })().finally(() => { clearTimeout(timeout); pending = null; });
    return pending;
  }
  function node(tag, text, className) {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function renderPrice(content, price) {
    content.replaceChildren();
    if (!price?.available || !Number.isFinite(price.min) || !Number.isFinite(price.max)) {
      content.appendChild(node("p", "No current price is published for this service. Check the booking page or contact us."));
      return;
    }
    const repair = price.kind === "inspection";
    const range = price.min === price.max ? currency.format(price.min)
      : `${currency.format(price.min)} – ${currency.format(price.max)}`;
    content.appendChild(node("strong", `${repair ? "Inspection fee" : "Service price"}: ${range} per ${repair ? "appliance" : "unit"}`, "landing-service-price-summary"));
    if (Array.isArray(price.rows) && price.rows.length > 1) {
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const headings = document.createElement("tr");
      for (const label of ["Option", repair ? "Inspection fee" : "Price per unit"]) {
        const th = node("th", label); th.scope = "col"; headings.appendChild(th);
      }
      head.appendChild(headings); table.appendChild(head);
      const body = document.createElement("tbody");
      for (const row of price.rows) {
        if (!Number.isFinite(row.amount) || row.amount < 0) continue;
        const tr = document.createElement("tr");
        tr.appendChild(node("td", row.label)); tr.appendChild(node("td", currency.format(row.amount)));
        body.appendChild(tr);
      }
      table.appendChild(body); content.appendChild(table);
    }
    content.appendChild(node("p", repair
      ? "This covers inspection only, not the final repair or replacement parts. Final repair pricing follows diagnosis and quotation. Travel fees are calculated separately when booking."
      : "Prices depend on the aircon type and HP selected. Travel fees and any additional charges are calculated separately when booking.", "landing-service-price-note"));
  }
  async function showPrices(modal, force = false) {
    const panel = modal.querySelector("[data-price-service]");
    const content = panel?.querySelector("[data-service-price-content]");
    if (!content) return;
    const token = {};
    tokens.set(panel, token);
    panel.setAttribute("aria-busy", "true");
    content.replaceChildren(node("p", "Loading current prices…"));
    try {
      const prices = await loadPrices(force);
      if (tokens.get(panel) === token) renderPrice(content, prices[panel.dataset.priceService]);
    } catch (_) {
      if (tokens.get(panel) !== token) return;
      const retry = node("button", "Retry prices", "btn btn-sm btn-outline-primary");
      retry.type = "button"; retry.setAttribute("data-service-price-retry", "");
      content.replaceChildren(node("p", "Prices could not be loaded. Try again or check the booking page."), retry);
    } finally {
      if (tokens.get(panel) === token) panel.setAttribute("aria-busy", "false");
    }
  }
  document.addEventListener("show.bs.modal", event => {
    if (event.target.matches?.(".landing-service-detail")) showPrices(event.target);
  });
  document.addEventListener("click", event => {
    const retry = event.target.closest?.("[data-service-price-retry]");
    const modal = retry?.closest(".landing-service-detail");
    if (modal) showPrices(modal, true);
  });
})();
