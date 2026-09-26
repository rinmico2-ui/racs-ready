(() => {
  const root = document.getElementById("orderProductReturns");
  if (!root) return;
  const orderId = root.dataset.orderId;
  const body = document.getElementById("orderReturnBody");
  const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("orderReturnModal"));
  const form = document.getElementById("orderReturnForm");
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  let items = [];
  let selected = null;
  async function api(url, options) {
    const response = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Please try again.");
    return data;
  }
  async function load() {
    try {
      const [eligibility, mine] = await Promise.all([
        api(`/api/product-returns/eligibility/order/${encodeURIComponent(orderId)}`),
        api("/api/product-returns/my"),
      ]);
      items = eligibility.items || [];
      const returns = (mine.returns || []).filter(row => String(row.sourceId) === orderId);
      body.innerHTML = `<p class="small text-muted mb-3">If a unit is defective or the wrong item arrived, tell us which product has the problem. A refund is not automatic—we check the item first.</p>${items.map(item => `<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 py-3 border-top"><div><strong>${esc(item.productName)}</strong><div class="small text-muted">${esc(item.purchased)} bought · ${esc(item.purchased - item.remaining)} in returns · ${esc(item.remaining)} can be requested${item.eligibleUntil ? ` · Until ${esc(new Date(item.eligibleUntil).toLocaleDateString("en-PH"))}` : ""}</div>${!item.eligible ? `<div class="small text-warning-emphasis">${esc(item.reason)}</div>` : ""}</div>${item.eligible ? `<button class="btn btn-sm btn-outline-primary" type="button" data-return-index="${item.index}">Request return</button>` : ""}</div>`).join("")}${returns.length ? `<div class="border-top pt-3 mt-2"><strong class="small">Your requests</strong>${returns.map(row => `<div class="small mt-2 d-flex justify-content-between gap-2"><span><strong>${esc(row.rmaNumber)}</strong> · ${esc(row.productName)} · ${esc(row.status.replace(/_/g, " "))}</span>${row.status === "requested" ? `<button type="button" class="btn btn-link btn-sm p-0" data-cancel-rma="${esc(row._id)}">Cancel</button>` : ""}</div>`).join("")}</div>` : ""}`;
    } catch (err) { body.textContent = `We could not check return options: ${err.message}`; }
  }
  body.addEventListener("click", event => {
    const cancelId = event.target.closest("[data-cancel-rma]")?.dataset.cancelRma;
    if (cancelId) {
      if (!confirm("Cancel this return request?")) return;
      api(`/api/product-returns/${encodeURIComponent(cancelId)}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
        .then(load).catch(err => alert(err.message));
      return;
    }
    const index = event.target.closest("[data-return-index]")?.dataset.returnIndex;
    if (index == null) return;
    selected = items.find(item => item.index === Number(index) && item.eligible);
    if (!selected) return;
    form.reset();
    document.getElementById("orderReturnError").classList.add("d-none");
    document.getElementById("orderReturnItemIndex").value = selected.index;
    document.getElementById("orderReturnQuantity").max = selected.remaining;
    document.getElementById("orderReturnProduct").textContent = `${selected.productName} · Up to ${selected.remaining} unit(s) can be requested. Please choose only the units with a problem.`;
    const serialWrap = document.getElementById("orderReturnSerialWrap");
    serialWrap.hidden = !selected.serialNumbers?.length;
    document.getElementById("orderReturnSerials").required = Boolean(selected.serialNumbers?.length);
    document.getElementById("orderReturnSerialHelp").textContent = selected.serialNumbers?.length ? `Serials recorded on this order: ${selected.serialNumbers.join(", ")}` : "";
    modal.show();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const button = document.getElementById("orderReturnSubmit");
    const box = document.getElementById("orderReturnError");
    box.classList.add("d-none"); button.disabled = true;
    try {
      const data = new FormData(form);
      data.set("sourceType", "order"); data.set("sourceId", orderId);
      await api("/api/product-returns", { method: "POST", body: data });
      modal.hide();
      await load();
    } catch (err) { box.textContent = err.message; box.classList.remove("d-none"); }
    finally { button.disabled = false; }
  });
  load();
})();
