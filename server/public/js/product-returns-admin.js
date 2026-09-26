(() => {
  const root = document.getElementById("productReturnsAdmin");
  if (!root) return;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const peso = value => `₱${Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const nice = value => String(value || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  let rows = [], selectedId = null, sale = null, eligibility = null;
  const statusFilter = $("rmaStatusFilter");
  const modal = bootstrap.Modal.getOrCreateInstance($("rmaCounterModal"));

  async function json(url, options) {
    const response = await fetch(url, { credentials: "same-origin", headers: options?.body instanceof FormData ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not complete the request.");
    return data;
  }
  async function load(preferredId) {
    try {
      const data = await json(`/api/product-returns/admin${statusFilter.value ? `?status=${encodeURIComponent(statusFilter.value)}` : ""}`);
      rows = data.returns || [];
      selectedId = preferredId || selectedId;
      if (!rows.some(row => row._id === selectedId)) selectedId = rows[0]?._id || null;
      renderList();
      if (selectedId) await open(selectedId);
      else { $("rmaDetailTitle").textContent = "Choose a request"; $("rmaDetail").innerHTML = '<div class="text-center rma-muted py-5">No requests in this filter.</div>'; }
    } catch (err) { $("rmaList").textContent = err.message; }
  }
  function renderList() {
    $("rmaList").innerHTML = rows.length ? rows.map(row => `<button type="button" class="rma-list-button ${row._id === selectedId ? "active" : ""}" data-open-rma="${esc(row._id)}"><div class="d-flex justify-content-between gap-2"><strong>${esc(row.rmaNumber)}</strong><span class="rma-status">${esc(nice(row.status))}</span></div><div class="small mt-1">${esc(row.productName)} · ${esc(row.quantity)} unit(s)${row.priority === "high" ? ' · <span class="text-danger fw-bold">Priority</span>' : ""}</div><div class="small rma-muted mt-1">${esc(row.customerName || "Counter customer")} · ${esc(row.sourceReference)}</div></button>`).join("") : '<p class="rma-muted mb-0">No requests yet.</p>';
  }
  const field = (label, value) => `<div class="rma-fact"><small>${esc(label)}</small><strong>${esc(value || "—")}</strong></div>`;
  const actionForm = (action, button, fields = "", tone = "primary") => `<form class="rma-action-panel mt-3" data-rma-action="${action}"><div class="fw-bold mb-2">${esc(button)}</div>${fields}<button class="btn btn-${tone} mt-2" type="submit">${esc(button)}</button></form>`;
  const noteField = (name = "note", required = false, hint = "Add a note for the customer") => `<label class="form-label small" for="rma_${name}">${esc(hint)}</label><textarea class="form-control" id="rma_${name}" name="${name}" rows="2" ${required ? 'required minlength="10"' : ""}></textarea>`;
  function nextActions(row, refund) {
    switch (row.status) {
      case "requested": return actionForm("review", "Start review", noteField()) + actionForm("reject", "Decline request", noteField("reason", true, "Explain why"), "outline-danger");
      case "under_review": return actionForm("approve-return", "Ask customer to bring item", noteField()) + actionForm("reject", "Decline request", noteField("reason", true, "Explain why"), "outline-danger");
      case "awaiting_return": return actionForm("receive", "Mark item received", '<div class="alert alert-warning small">The returned item will go into quarantine, not sellable stock.</div>' + noteField());
      case "received": return actionForm("inspect", "Save inspection", `<div class="row g-2"><div class="col-md-6"><label class="form-label">Result</label><select name="result" class="form-select" required><option value="">Choose result</option>${["defect_confirmed", "not_confirmed", "customer_damage", "misuse", "missing_components", "wrong_item", "warranty_covered", "warranty_not_covered", "further_diagnosis"].map(value => `<option value="${value}">${esc(nice(value))}</option>`).join("")}</select></div><div class="col-md-6"><label class="form-label">Physical condition</label><input class="form-control" name="condition" maxlength="500"></div></div><div class="d-flex flex-wrap gap-3 my-2"><label><input type="checkbox" name="serialVerified"> Serial checked</label><label><input type="checkbox" name="accessoriesComplete"> Accessories complete</label><label><input type="checkbox" name="signsOfMisuse"> Signs of misuse</label><label><input type="checkbox" name="resellable"> Safe to resell after resolution</label></div>${noteField("notes", true, "Inspection findings")}<label class="form-label mt-2">Inspection photos (optional)</label><input class="form-control" type="file" name="evidence" accept="image/png,image/jpeg,image/webp" multiple>`);
      case "inspected": {
        if (row.inspection?.result === "further_diagnosis") return actionForm("inspect", "Record further inspection", `<label class="form-label">Result</label><select name="result" class="form-select" required>${["defect_confirmed", "not_confirmed", "customer_damage", "misuse", "missing_components", "wrong_item", "warranty_covered", "warranty_not_covered"].map(value => `<option value="${value}">${esc(nice(value))}</option>`).join("")}</select>${noteField("notes", true, "Updated findings")}`);
        const choices = ["refund", "replacement", ...(row.bookingId ? ["repair"] : [])];
        return actionForm("decision", "Record decision", `<label class="form-label">Resolution</label><select name="resolution" class="form-select">${choices.map(value => `<option value="${value}" ${value === row.requestedResolution ? "selected" : ""}>${nice(value)}${value === row.requestedResolution ? " (requested)" : ""}</option>`).join("")}</select>${!row.bookingId ? '<div class="small text-muted mt-1">Warranty repair needs a linked service booking.</div>' : ""}${noteField("reason", true, "Why this resolution?")}`) + actionForm("reject", "Decline after inspection", noteField("reason", true, "Explain why"), "outline-danger");
      }
      case "refund_pending": return actionForm("refund-approve", "Approve product refund", `<div class="alert alert-info small">Maximum from this item and its confirmed payment: <strong>${peso(row.maxRefundable)}</strong>. Installation and travel are excluded.</div><label class="form-label">Approved amount</label><input name="amount" class="form-control" type="number" min="0.01" max="${esc(row.maxRefundable)}" step="0.01" value="${esc(row.maxRefundable)}" required>`);
      case "refund_approved": return actionForm("refund-processing", "Start manual refund", `<div class="small rma-muted">No money is sent by this button. Process the refund outside this system, then record proof.</div>`);
      case "refund_processing": return actionForm("refund-complete", "Record refund sent", `<div class="small mb-2">Approved: <strong>${peso(refund?.amount)}</strong>. Do this only after the customer has actually received the money.</div><label class="form-label">Method</label><select name="method" class="form-select" required><option value="">Choose method</option>${["gcash", "maya", "bank", "cash", "card", "other"].map(value => `<option value="${value}">${nice(value)}</option>`).join("")}</select><label class="form-label mt-2">Transfer reference or cash receipt number</label><input name="reference" class="form-control" minlength="4" required><label class="form-label mt-2">Proof image (required except cash)</label><input name="proof" class="form-control" type="file" accept="image/png,image/jpeg,image/webp"><label class="form-label mt-2">Notes</label><textarea name="notes" class="form-control" rows="2"></textarea>`);
      case "replacement_pending": return actionForm("replacement-complete", "Release replacement", `<div class="alert alert-warning small">This deducts ${esc(row.quantity)} replacement unit(s) from sellable stock. The returned item remains quarantined.</div><label class="form-label">New serial numbers (comma-separated for aircons)</label><input name="newSerialNumbers" class="form-control" placeholder="ABC123, XYZ456"><div class="small rma-muted mt-1">Use the same SKU. Price-difference exchanges require a separate sale/refund review.</div>${noteField()}`);
      case "repair_pending": return actionForm("repair-complete", "Close completed repair", `<label class="form-label">Completed work order ID</label><input name="workOrderId" class="form-control" required>${noteField("notes", true, "Repair and handover notes")}`);
      case "completed": return row.inspection?.resellable && row.inventoryDisposition !== "restocked" && ["refund", "replacement"].includes(row.resolution?.type)
        ? actionForm("restock", "Restock inspected item", '<div class="alert alert-warning small">Only do this if the item is physically safe and complete.</div>' + noteField())
        : '<div class="alert alert-secondary mb-0">This return is complete. The original sale and payment remain on record.</div>';
      case "rejected": return row.receivedAt && row.inventoryDisposition !== "customer_held"
        ? actionForm("return-to-customer", "Record customer pickup", '<div class="small text-muted mb-2">The rejected item stays out of sellable stock until it is physically handed back.</div>' + noteField())
        : '<div class="alert alert-secondary mb-0">The request was declined. No refund or stock adjustment is available.</div>';
      default: return '<div class="alert alert-secondary mb-0">No further action is available for this request.</div>';
    }
  }
  async function open(id) {
    selectedId = id;
    renderList();
    $("rmaDetail").innerHTML = '<div class="text-center py-4">Loading return details…</div>';
    try {
      const { return: row, refund } = await json(`/api/product-returns/${encodeURIComponent(id)}`);
      $("rmaDetailTitle").textContent = `${row.rmaNumber} · ${row.productName}`;
      $("rmaDetailSubtitle").textContent = `${nice(row.status)} · ${row.sourceReference}`;
      const topFacts = `<div class="row g-2 mb-3"><div class="col-sm-6 col-xl-3">${field("Customer", row.customerName)}</div><div class="col-sm-6 col-xl-3">${field("Product", row.productName)}</div><div class="col-sm-6 col-xl-3">${field("Quantity", row.quantity)}</div><div class="col-sm-6 col-xl-3">${field("Maximum item refund", peso(row.maxRefundable))}</div></div>`;
      const stateFacts = `<div class="row g-2 mb-3"><div class="col-sm-6">${field("Issue", `${nice(row.reason)} · ${row.description}`)}</div><div class="col-sm-6">${field("Inspection", row.inspection?.result ? `${nice(row.inspection.result)} · ${row.inspection.notes}` : "Not inspected yet")}</div><div class="col-sm-6">${field("Returned stock", nice(row.inventoryDisposition))}</div><div class="col-sm-6">${field("Resolution", row.resolution?.type ? `${nice(row.resolution.type)}${refund ? ` · ${peso(refund.amount)} (${nice(refund.status)})` : ""}` : "Not decided yet")}</div></div>`;
      const purchaseDetails = `<details class="mb-3"><summary class="fw-semibold" style="cursor:pointer">Original sale and coverage</summary><div class="row g-2 mt-2"><div class="col-sm-6">${field("Receipt / order", row.sourceReference)}</div><div class="col-sm-6">${field("Purchase date", new Date(row.purchaseDate).toLocaleDateString("en-PH"))}</div><div class="col-sm-6">${field("Coverage", nice(row.coverageType))}</div><div class="col-sm-6">${field("Recorded end date", row.eligibleUntil ? new Date(row.eligibleUntil).toLocaleDateString("en-PH") : "Not recorded")}</div><div class="col-sm-6">${field("Serial number(s)", (row.serialNumbers || []).join(", ") || "Not recorded")}</div><div class="col-sm-6">${field("Related booking", row.bookingId || "None")}</div><div class="col-sm-6">${field("Reviewer", row.reviewerName || "Not assigned")}</div></div></details>`;
      const refundDetails = refund ? `<details class="mb-3"><summary class="fw-semibold" style="cursor:pointer">Refund record</summary><div class="row g-2 mt-2"><div class="col-sm-6">${field("Amount", peso(refund.amount))}</div><div class="col-sm-6">${field("Status", nice(refund.status))}</div><div class="col-sm-6">${field("Method", nice(refund.method))}</div><div class="col-sm-6">${field("Reference", refund.reference)}</div><div class="col-sm-6">${field("Original payment", refund.originalPaymentId || "Counter-sale receipt")}</div>${refund.proofUrl ? `<div class="col-sm-6"><a href="${esc(refund.proofUrl)}" target="_blank" rel="noopener">View refund proof</a></div>` : ""}</div></details>` : "";
      const photos = (row.evidenceUrls?.length || row.inspection?.evidenceUrls?.length) ? `<div class="mb-3"><strong class="small">Evidence photos</strong><div class="d-flex flex-wrap gap-2 mt-2">${(row.evidenceUrls || []).map((url, index) => `<a class="btn btn-sm btn-outline-secondary" href="${esc(url)}" target="_blank" rel="noopener">Customer ${index + 1}</a>`).join("")}${(row.inspection?.evidenceUrls || []).map((url, index) => `<a class="btn btn-sm btn-outline-secondary" href="${esc(url)}" target="_blank" rel="noopener">Inspection ${index + 1}</a>`).join("")}</div></div>` : "";
      const history = `<div class="mt-4"><strong>History</strong><div class="rma-history">${(row.history || []).slice().reverse().map(entry => `<div class="rma-step"><strong>${esc(nice(entry.action))}</strong><small class="d-block">${esc(new Date(entry.at).toLocaleString("en-PH"))} · ${esc(entry.actorRole)}</small><div class="small">${esc(entry.note)}</div></div>`).join("")}</div></div>`;
      const bookingLink = row.sourceType === "walk_in" && !row.bookingId && ["requested", "under_review", "awaiting_return", "received", "inspected"].includes(row.status)
        ? actionForm("link-booking", "Link service booking", '<label class="form-label">Booking number</label><input class="form-control" name="bookingReference" required><div class="small text-muted mt-1">Use this if CALIDRO installed the returned part.</div>', "outline-primary") : "";
      $("rmaDetail").innerHTML = topFacts + stateFacts + purchaseDetails + refundDetails + photos + '<div id="rmaActionError" class="alert alert-danger d-none mb-3" role="alert"></div>' + nextActions(row, refund) + bookingLink + history;
    } catch (err) { $("rmaDetail").textContent = err.message; }
  }
  root.addEventListener("click", event => { const id = event.target.closest("[data-open-rma]")?.dataset.openRma; if (id) open(id); });
  root.addEventListener("submit", async event => {
    const form = event.target.closest("[data-rma-action]");
    if (!form) return;
    event.preventDefault();
    const action = form.dataset.rmaAction;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    const body = ["refund-complete", "inspect"].includes(action) ? new FormData(form) : Object.fromEntries(new FormData(form));
    for (const name of ["serialVerified", "accessoriesComplete", "signsOfMisuse", "resellable"]) {
      if (!form.elements[name]) continue;
      if (body instanceof FormData) body.set(name, form.elements[name].checked ? "true" : "false");
      else body[name] = form.elements[name].checked;
    }
    try {
      await json(`/api/product-returns/${encodeURIComponent(selectedId)}/${action}`, { method: "POST", body: body instanceof FormData ? body : JSON.stringify(body) });
      await load(selectedId);
    } catch (err) { const box = $("rmaActionError"); box.textContent = err.message; box.classList.remove("d-none"); box.scrollIntoView({ behavior: "smooth", block: "center" }); button.disabled = false; }
  });
  statusFilter.addEventListener("change", () => { selectedId = null; load(); });
  $("rmaOpenCounter").addEventListener("click", () => { $("rmaCounterForm").reset(); $("rmaCounterFields").hidden = true; $("rmaCounterSubmit").disabled = true; $("rmaCounterError").classList.add("d-none"); modal.show(); });
  $("rmaFindInvoice").addEventListener("click", async () => {
    const invoice = $("rmaInvoice").value.trim();
    const box = $("rmaCounterError"); box.classList.add("d-none");
    try {
      const result = await json(`/api/product-returns/counter-sale/${encodeURIComponent(invoice)}`);
      sale = result.sale;
      eligibility = result;
      $("rmaCounterItem").innerHTML = eligibility.items.map(item => `<option value="${item.index}" ${item.eligible ? "" : "disabled"}>${esc(item.productName)} · ${item.remaining} eligible</option>`).join("");
      $("rmaCounterFields").hidden = false;
      $("rmaCounterSubmit").disabled = !eligibility.items.some(item => item.eligible);
      $("rmaCounterItem").dispatchEvent(new Event("change"));
    } catch (err) { box.textContent = err.message; box.classList.remove("d-none"); }
  });
  $("rmaCounterItem").addEventListener("change", () => { const item = eligibility?.items.find(row => row.index === Number($("rmaCounterItem").value)); $("rmaCounterQuantity").max = item?.remaining || 1; $("rmaCounterEligibility").textContent = item ? (item.eligible ? `Up to ${item.remaining} unit(s). Review available until ${new Date(item.eligibleUntil).toLocaleDateString("en-PH")}.` : item.reason) : ""; });
  $("rmaCounterForm").addEventListener("submit", async event => {
    event.preventDefault();
    const box = $("rmaCounterError"); box.classList.add("d-none");
    const button = $("rmaCounterSubmit"); button.disabled = true;
    try {
      const selectedItem = eligibility.items.find(row => row.index === Number($("rmaCounterItem").value));
      const data = await json("/api/product-returns", { method: "POST", body: JSON.stringify({ sourceType: "walk_in", sourceId: sale._id, itemIndex: Number($("rmaCounterItem").value), quantity: Number($("rmaCounterQuantity").value), serialNumbers: selectedItem?.serialNumbers || [], reason: $("rmaCounterReason").value, description: $("rmaCounterDescription").value, requestedResolution: $("rmaCounterResolution").value, bookingReference: $("rmaBookingReference").value.trim() }) });
      modal.hide(); statusFilter.value = ""; await load(data.return._id);
    } catch (err) { box.textContent = err.message; box.classList.remove("d-none"); button.disabled = false; }
  });
  $("rmaPolicyForm").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      await json("/api/product-returns/policy", { method: "PATCH", body: JSON.stringify({ returnDays: Number($("rmaReturnDays").value) }) });
      alert("Return period saved for future requests.");
    } catch (err) { alert(err.message); }
  });
  json("/api/product-returns/policy").then(data => { $("rmaReturnDays").value = data.returnDays; }).catch(() => {});
  load();
})();
