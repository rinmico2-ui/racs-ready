document.addEventListener("DOMContentLoaded", function () {
  const page = document.querySelector(".ordered-products-page");
  if (!page) return;

  const searchInput = document.getElementById("ordersSearch");
  const dateFilter = document.getElementById("ordersDateFilter");
  const filterBtn = document.getElementById("ordersFilterBtn");
  const tbody = document.getElementById("ordersTableBody");

  const detailsModalEl = document.getElementById("orderDetailsModal");
  const detailsModal = detailsModalEl ? new bootstrap.Modal(detailsModalEl) : null;
  const detailsBody = document.getElementById("orderDetailsBody");

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatCurrency(value) {
    const num = Number(value || 0);
    return num.toLocaleString("en-PH", {
      style: "currency",
      currency: "PHP",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function renderRows(items) {
    if (!tbody) return;
    if (!Array.isArray(items) || !items.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">No orders found.</td></tr>';
      return;
    }
    tbody.innerHTML = items
      .map((o) => {
        const id = o._id;
        const cust = o.customerName || "-";
        const total = formatCurrency(o.total);
        const date = o.purchaseDate ? new Date(o.purchaseDate).toLocaleDateString("en-PH") : "-";
        const itemSummary = Array.isArray(o.items)
          ? o.items
              .map((it) => {
                const label = it.productId && it.productId.itemName ? it.productId.itemName : it.name;
                return `${escapeHtml(label)}\u00A0(x${it.quantity})`;
              })
              .join(", ")
          : "";
        return `
          <tr id="order-row-${escapeHtml(id)}">
            <td class="ps-4 td-truncate-md" title="${escapeHtml(id)}">
              <div class="fw-bold text-dark text-truncate">${escapeHtml(id)}</div>
            </td>
            <td class="td-truncate-md" title="${escapeHtml(cust)}">
              <div class="fw-semibold text-truncate text-dark">${escapeHtml(cust)}</div>
            </td>
            <td class="td-truncate-lg" title="${escapeHtml(itemSummary)}">
              <div class="text-truncate text-dark">${escapeHtml(itemSummary)}</div>
            </td>
            <td class="fw-bold text-dark">${escapeHtml(total)}</td>
            <td>${escapeHtml(date)}</td>
            <td class="text-end pe-4">
              <button class="btn btn-micro btn-light border js-view-order" data-order-id="${escapeHtml(id)}" title="View details">
                <i class="bi bi-eye"></i>
              </button>
            </td>
          </tr>`;
      })
      .join("");
  }

  async function fetchOrders() {
    const params = new URLSearchParams();
    if (searchInput && searchInput.value.trim()) params.set("search", searchInput.value.trim());
    if (dateFilter && dateFilter.value) params.set("from", dateFilter.value);
    try {
      const resp = await fetch(`/api/admin/purchases?${params.toString()}`);
      if (!resp.ok) throw new Error("fetch failed");
      const data = await resp.json();
      renderRows(data.purchases || []);
    } catch (err) {
      console.error(err);
    }
  }

  function showOrderDetails(id) {
    if (!detailsModal) return;
    detailsBody.innerHTML = '<p class="text-center text-muted py-4">Loading...</p>';
    detailsModal.show();
    fetch(`/api/admin/purchases/${encodeURIComponent(id)}`)
      .then((r) => r.ok ? r.json() : Promise.reject(r))
      .then((d) => {
        const o = d.purchase;
        if (!o) {
          detailsBody.innerHTML = '<p class="text-center text-danger">Not found</p>';
          return;
        }
        const lines = [];
        lines.push(`<div><strong>Order ID:</strong> ${escapeHtml(o._id)}</div>`);
        lines.push(`<div><strong>Customer:</strong> ${escapeHtml(o.customerName || "")} &lt;${escapeHtml(o.customerEmail||"")}&gt;</div>`);
        lines.push(`<div><strong>Date:</strong> ${escapeHtml(new Date(o.purchaseDate).toLocaleString("en-PH"))}</div>`);
        lines.push("<hr/>");
        if (Array.isArray(o.items)) {
          lines.push("<div><strong>Items</strong></div>");
          lines.push("<ul class=\"ps-3\">");
          o.items.forEach((it) => {
            const label = it.productId && it.productId.itemName ? it.productId.itemName : it.name;
            lines.push(`<li>${escapeHtml(label)} x${escapeHtml(it.quantity)} @ ${escapeHtml(formatCurrency(it.unitPrice))} = ${escapeHtml(formatCurrency(it.totalPrice))}</li>`);
          });
          lines.push("</ul>");
        }
        lines.push(`<hr/><div><strong>Total:</strong> ${escapeHtml(formatCurrency(o.total))}</div>`);
        detailsBody.innerHTML = lines.join("");
      })
      .catch((e) => {
        detailsBody.innerHTML = '<p class="text-center text-danger">Failed to load</p>';
        console.error(e);
      });
  }

  filterBtn && filterBtn.addEventListener("click", fetchOrders);
  searchInput && searchInput.addEventListener("keyup", (e) => {
    if (e.key === "Enter") fetchOrders();
  });

  tbody.addEventListener("click", (e) => {
    const btn = e.target.closest(".js-view-order");
    if (btn) {
      showOrderDetails(btn.getAttribute("data-order-id"));
    }
  });

  // initial load
  fetchOrders();
});