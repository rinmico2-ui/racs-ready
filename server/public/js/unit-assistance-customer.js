(() => {
  const root = document.getElementById('unitRequests');
  const message = document.getElementById('unitRequestMessage');
  const money = value => `₱${Number(value || 0).toLocaleString('en-PH')}`;
  function showError(value) { message.textContent = value; message.classList.remove('d-none'); }
  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = content;
    return node;
  }
  async function load() {
    try {
      const response = await fetch('/api/unit-assistance/mine', { credentials: 'same-origin' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load requests.');
      root.replaceChildren();
      if (!data.requests.length) root.append(el('p', 'text-muted', 'No identification requests yet.'));
      for (const request of data.requests) {
        const card = el('section', 'card shadow-sm mb-3');
        const body = el('div', 'card-body');
        body.append(el('h2', 'h5', request.serviceName), el('p', 'text-muted small mb-2',
          `Requested ${new Date(request.createdAt).toLocaleDateString('en-PH')} · ${request.quantity} unit(s) · ${request.status.replaceAll('_', ' ')}`));
        if (request.existingBookingId) body.append(el('p', 'small fw-bold', `Existing booking: ${request.existingBookingReference || request.existingBookingId}`));
        if (request.status === 'pending') body.append(el('p', 'mb-0', 'Staff will identify the unit and send a price here. No payment or slot has been reserved.'));
        if (request.quote) {
          body.append(el('p', 'mb-1', `${request.quote.brand || 'Brand unknown'} · ${request.quote.airconTypeName || request.quote.airconType || 'Aircon'} · ${request.quote.hp} HP`));
          body.append(el('p', 'fw-bold mb-1', `${money(request.quote.unitPrice)} per unit · ${money(request.quote.unitPrice * request.quantity)} for ${request.quantity} unit(s), before travel fare`));
          if (request.quote.notes) body.append(el('p', 'small text-muted', request.quote.notes));
          if (request.status === 'quoted') {
            const expired = new Date(request.quote.expiresAt) <= new Date();
            body.append(el('p', 'small text-muted', expired ? 'Quote expired. Contact the store for a new quote.' : `Quote valid until ${new Date(request.quote.expiresAt).toLocaleDateString('en-PH')}. Schedule availability is checked when you book.`));
            if (!expired) {
              for (const [decision, label, style] of [['accept', request.existingBookingId ? 'Accept service change quote' : 'Accept and choose schedule', 'btn btn-primary me-2'], ['decline', 'Decline', 'btn btn-outline-secondary']]) {
                const button = el('button', style, label); button.type = 'button';
                button.addEventListener('click', async () => {
                  button.disabled = true;
                  try {
                    const response = await fetch(`/api/unit-assistance/mine/${request._id}/decision`, {
                      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ decision }),
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error || 'Could not save your choice.');
                    if (decision === 'accept' && !request.existingBookingId) location.assign(`/services?assistanceId=${encodeURIComponent(request._id)}`);
                    else load();
                  } catch (error) { showError(error.message); button.disabled = false; }
                });
                body.append(button);
              }
            }
          }
          if (request.status === 'accepted') {
            if (request.existingBookingId) body.append(el('p', 'mb-0', 'Staff will review the change to your existing booking and any payment adjustment. Your current booking remains as shown in My Bookings.'));
            else if (new Date(request.quote.expiresAt) <= new Date()) body.append(el('p', 'mb-0 text-warning', 'This quote expired before booking. Contact the store for an updated quote.'));
            else {
              const link = el('a', 'btn btn-primary', 'Continue booking');
              link.href = `/services?assistanceId=${encodeURIComponent(request._id)}`;
              body.append(link);
            }
          }
          if (request.status === 'resolved') body.append(el('p', 'mb-0', 'Staff handled this request. Review My Bookings for the updated status.'));
        }
        card.append(body); root.append(card);
      }
    } catch (error) { root.replaceChildren(); showError(error.message); }
  }
  load();
})();
