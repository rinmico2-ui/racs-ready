(() => {
  const root = document.getElementById('unitStaffRequests');
  const message = document.getElementById('unitStaffMessage');
  const el = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = content;
    return node;
  };
  function showError(value) { message.textContent = value; message.classList.remove('d-none'); }
  function option(value, label) { const node = el('option', '', label); node.value = value; return node; }
  async function load() {
    try {
      const response = await fetch('/api/unit-assistance/staff', { credentials: 'same-origin' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load the queue.');
      root.replaceChildren();
      if (!data.requests.length) root.append(el('p', 'text-muted', 'No open unit identification requests.'));
      for (const request of data.requests) {
        const catalog = request.serviceId;
        const col = el('div', 'col-12 col-xl-6');
        const card = el('section', 'card shadow-sm h-100');
        const body = el('div', 'card-body');
        const customer = request.customerId || {};
        body.append(el('h2', 'h5', request.serviceName),
          el('p', 'small text-muted', `${customer.firstName || ''} ${customer.lastName || ''} · ${customer.email || ''} · ${customer.phone || customer.mobile || ''}`),
          el('p', 'mb-2', `${request.quantity} unit(s) · Brand: ${request.brand || 'Unknown'} · Type: ${request.airconType || 'Unknown'} · HP: ${request.hp || 'Unknown'}`));
        if (request.existingBookingId) body.append(el('p', 'fw-bold small', `Existing booking: ${request.existingBookingReference || request.existingBookingId}`));
        if (request.notes) body.append(el('p', 'small', `Customer notes: ${request.notes}`));
        body.append(el('p', 'small text-muted', `Status: ${request.status}`));
        if ((request.status === 'pending' || request.status === 'quoted' || (request.status === 'accepted' && !request.existingBookingId)) && catalog?.active !== false) {
          const form = el('form', 'row g-2');
          const brandWrap = el('div', 'col-12');
          const brand = el('input', 'form-control'); brand.name = 'brand'; brand.maxLength = 80;
          brand.placeholder = 'Verified brand or I don\'t know'; brand.value = request.quote?.brand || request.brand || '';
          brandWrap.append(el('label', 'form-label', 'Brand'), brand);
          const typeWrap = el('div', 'col-sm-6');
          typeWrap.append(el('label', 'form-label', 'Verified type'));
          const type = el('select', 'form-select'); type.required = Boolean(catalog.airconTypes?.length);
          type.append(option('', 'Choose type'));
          for (const item of catalog.airconTypes || []) type.append(option(item.type, item.name));
          type.value = request.quote?.airconType || request.airconType || '';
          typeWrap.append(type);
          const hpWrap = el('div', 'col-sm-6');
          hpWrap.append(el('label', 'form-label', 'Verified HP'));
          const hp = el('select', 'form-select'); hp.required = true;
          hpWrap.append(hp);
          const price = el('p', 'col-12 small text-primary mb-0');
          function updateTiers() {
            const selected = (catalog.airconTypes || []).find(item => item.type === type.value);
            const tiers = selected?.hpPricing || (catalog.airconTypes?.length ? [] : catalog.hpPricing || []);
            hp.replaceChildren(option('', 'Choose HP'));
            for (const item of tiers) hp.append(option(String(item.hp), `${item.hp} HP · ₱${Number(item.price).toLocaleString('en-PH')} per unit`));
            const previous = request.quote?.hp || request.hp;
            if (tiers.some(item => Number(item.hp) === Number(previous))) hp.value = String(previous);
            price.textContent = 'The catalog price is calculated from the chosen type and HP.';
          }
          type.addEventListener('change', updateTiers); updateTiers();
          const notesWrap = el('div', 'col-12'); notesWrap.append(el('label', 'form-label', 'Notes to customer'));
          const notes = el('textarea', 'form-control'); notes.rows = 2; notes.maxLength = 1000; notes.value = request.quote?.notes || '';
          notesWrap.append(notes);
          const verifyWrap = el('div', 'col-12'); verifyWrap.append(el('label', 'form-label', 'How were these details verified?'));
          const verificationMethod = el('select', 'form-select'); verificationMethod.required = true;
          verificationMethod.append(option('', 'Choose verification method'), option('customer_contact', 'Confirmed with customer'),
            option('model_label', 'Checked model label'), option('site_visit', 'Checked during site visit'));
          verificationMethod.value = request.quote?.verificationMethod || '';
          verifyWrap.append(verificationMethod);
          const submit = el('button', 'btn btn-primary', request.status === 'quoted' ? 'Update quote' : 'Send quote');
          submit.type = 'submit';
          form.append(brandWrap, typeWrap, hpWrap, price, notesWrap, verifyWrap, submit);
          form.addEventListener('submit', async event => {
            event.preventDefault(); submit.disabled = true;
            try {
              const response = await fetch(`/api/unit-assistance/staff/${request._id}/quote`, {
                method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ brand: brand.value.trim() || "I don't know", airconType: type.value, hp: hp.value, notes: notes.value, verificationMethod: verificationMethod.value }),
              });
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || 'Could not save quote.');
              message.classList.add('d-none'); load();
            } catch (error) { showError(error.message); submit.disabled = false; }
          });
          body.append(form);
        } else if (!catalog) body.append(el('p', 'text-danger', 'Service no longer exists. Contact the customer.'));
        else if (request.quote) body.append(el('p', 'fw-bold', `Accepted quote: ₱${Number(request.quote.unitPrice * request.quantity).toLocaleString('en-PH')}, before travel fare`));
        if (request.status === 'accepted' && request.existingBookingId) {
          const form = el('form', 'mt-3');
          const notes = el('textarea', 'form-control mb-2'); notes.rows = 2; notes.maxLength = 1000;
          notes.placeholder = 'Record the booking update and payment adjustment (at least 10 characters)'; notes.required = true;
          const confirm = el('label', 'd-block small mb-2');
          const checkbox = el('input', 'form-check-input me-2'); checkbox.type = 'checkbox'; checkbox.required = true;
          confirm.append(checkbox, document.createTextNode('I handled the existing booking and payment adjustment.'));
          const submit = el('button', 'btn btn-success', 'Mark handled'); submit.type = 'submit';
          form.append(notes, confirm, submit);
          form.addEventListener('submit', async event => {
            event.preventDefault(); submit.disabled = true;
            try {
              const response = await fetch(`/api/unit-assistance/staff/${request._id}/resolve`, {
                method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirmed: checkbox.checked, notes: notes.value }),
              });
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || 'Could not close this request.');
              message.classList.add('d-none'); load();
            } catch (error) { showError(error.message); submit.disabled = false; }
          });
          body.append(form);
        }
        card.append(body); col.append(card); root.append(col);
      }
    } catch (error) { root.replaceChildren(); showError(error.message); }
  }
  load();
})();
