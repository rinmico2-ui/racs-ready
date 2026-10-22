(function () {
  'use strict';
  const pending = new Map();
  const php = value => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(value);
  const escape = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

  async function summary(id) {
    const response = await fetch('/api/orders/' + encodeURIComponent(id) + '/collection-summary', { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load the current balance. Please try again.');
    if (!Number.isFinite(Number(data.balanceDue)) || Number(data.balanceDue) < 0) throw new Error('The order balance could not be confirmed. Please refresh your orders.');
    return data;
  }

  function location() {
    return new Promise(resolve => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(position => resolve({ lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy }), () => resolve(null), { timeout: 5000 });
    });
  }

  async function open(id, onCollected) {
    function reflectCollection(payment) {
      try { onCollected?.(payment); }
      catch (error) { console.warn('Payment is saved; could not update the order display:', error.message); }
    }
    let current = await summary(id);
    if (Number(current.balanceDue) === 0) {
      reflectCollection({ balanceAmount: 0, paymentStatus: current.paymentStatus });
      return true;
    }
    let submitting = false;
    const element = name => document.getElementById('op' + name);
    function updateBill() {
      element('Total').textContent = php(current.total);
      element('Paid').textContent = '-' + php(current.amountPaid);
      element('PaidRow').hidden = Number(current.amountPaid) <= 0;
      element('Balance').textContent = php(current.balanceDue);
      element('Amount').value = element('Amount').min = element('Amount').max = String(current.balanceDue);
      element('CashLabel').textContent = 'I received ' + php(current.balanceDue) + ' in cash.';
      element('CashConfirmed').checked = false;
    }
    function syncMethod() {
      const cash = element('Method').value === 'cash';
      element('CashWrap').hidden = !cash;
      element('CashConfirmed').checked = false;
      element('CashConfirmed').disabled = !cash;
      element('CashConfirmed').required = cash;
      element('TransferWrap').hidden = cash;
      element('Ref').disabled = cash;
      element('Ref').required = !cash;
    }
    const result = await Swal.fire({
      title: 'Collect Payment', width: 540,
      customClass: { popup: 'order-payment-dialog', htmlContainer: 'order-payment-content', confirmButton: 'order-payment-confirm' },
      html: `<div class="order-payment-form text-start">
        <p class="order-payment-customer">${escape(current.customerName || 'Customer')}<span>${escape(current.orderReference || 'Order collection')}</span></p>
        <div class="order-payment-bill">
          <div class="order-payment-bill-row"><span>Total bill</span><strong id="opTotal"></strong></div>
          <div class="order-payment-bill-row" id="opPaidRow"><span>Less: Recorded payments</span><strong id="opPaid"></strong></div>
          <div class="order-payment-balance"><span>Balance due</span><strong id="opBalance"></strong></div>
        </div>
        <div class="mb-3"><label for="opAmount" class="form-label fw-semibold">Amount received</label>
          <div class="input-group"><span class="input-group-text">&#8369;</span><input id="opAmount" type="number" class="form-control" step="0.01" readonly aria-describedby="opAmountHint"></div>
          <div id="opAmountHint" class="form-text">Record the full balance received from the customer.</div>
        </div>
        <div class="mb-3"><label for="opMethod" class="form-label fw-semibold">Payment method <span class="text-danger">*</span></label>
          <select id="opMethod" class="form-select"><option value="cash">Cash</option><option value="gcash">GCash</option><option value="bank">Bank Transfer</option></select>
        </div>
        <div id="opCashWrap" class="order-payment-cash mb-3">
          <div class="form-check"><input id="opCashConfirmed" type="checkbox" class="form-check-input" aria-describedby="opCashHint">
            <label id="opCashLabel" for="opCashConfirmed" class="form-check-label fw-semibold"></label></div>
          <div id="opCashHint" class="form-text">Count the cash before confirming.</div>
        </div>
        <div id="opTransferWrap" hidden>
          <div class="mb-3"><label for="opRef" class="form-label fw-semibold">Reference number <span class="text-danger">*</span></label><input id="opRef" class="form-control" maxlength="120" autocomplete="off"></div>
        </div>
        <details class="order-payment-support"><summary>Add a note <span>(optional)</span></summary>
          <div class="mt-3"><label for="opNotes" class="form-label">Notes <span class="text-muted">(optional)</span></label><textarea id="opNotes" class="form-control" rows="2" maxlength="1000" placeholder="Add a payment note"></textarea></div>
        </details>
        <p class="order-payment-reminder">This records the customer payment. Admin verifies the remittance separately.</p>
      </div>`,
      showCancelButton: true, cancelButtonText: 'Back', confirmButtonText: 'Collect Payment',
      confirmButtonColor: '#059669', focusConfirm: false, showLoaderOnConfirm: true,
      allowOutsideClick: () => !submitting, allowEscapeKey: () => !submitting,
      didOpen() {
        updateBill(); syncMethod();
        element('Method').addEventListener('change', syncMethod);
      },
      preConfirm: async () => {
        if (submitting) return false;
        let finish, saved = false;
        const method = element('Method').value;
        const reference = method === 'cash' ? '' : element('Ref').value.trim();
        const cashReceivedConfirmed = method === 'cash' && element('CashConfirmed').checked;
        const notes = element('Notes').value.trim();
        const amount = round(element('Amount').value);
        const fields = ['Method', 'CashConfirmed', 'Ref', 'Notes'];
        try {
          if (!['cash', 'gcash', 'bank'].includes(method)) throw new Error('Choose a payment method.');
          if (amount <= 0 || amount !== round(current.balanceDue)) throw new Error('Record the full remaining balance of ' + php(current.balanceDue) + '.');
          if (method === 'cash' && !cashReceivedConfirmed) { element('CashConfirmed').focus(); throw new Error('Confirm that you received the cash before recording this collection.'); }
          if (method !== 'cash' && !reference) throw new Error('Enter the GCash or bank transfer reference number.');
          submitting = true;
          fields.forEach(name => { element(name).disabled = true; });
          // Recheck after the technician reviews the bill. Another device may
          // have recorded payment or operations may have changed the order.
          const latest = await summary(id);
          if (Number(latest.balanceDue) === 0) {
            saved = true;
            reflectCollection({ balanceAmount: 0, paymentStatus: latest.paymentStatus });
            return { alreadyCollected: true };
          }
          if (round(latest.balanceDue) !== amount) {
            current = latest; updateBill();
            throw new Error('The balance changed. Review the updated bill and confirm the amount received again.');
          }
          const coordinates = await location();
          finish = window.TechnicianWorkUpdates?.beginMutation();
          const response = await fetch('/api/orders/' + encodeURIComponent(id) + '/collect-payment', {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount, method, reference, cashReceivedConfirmed, notes, location: coordinates })
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Could not record the payment. Please try again.');
          saved = true;
          reflectCollection(data);
          let refreshed;
          try { refreshed = await finish?.(); }
          catch (_) { refreshed = false; }
          return { refreshFailed: refreshed === false };
        } catch (error) {
          // Keep the method, reference and notes available for correction/retry.
          Swal.showValidationMessage(error.message || 'Could not confirm the collection. Check your connection and try again.');
          return false;
        } finally {
          if (!saved) finish?.(false);
          submitting = false;
          fields.forEach(name => { element(name).disabled = false; });
          const cash = method === 'cash';
          element('CashConfirmed').disabled = !cash;
          element('Ref').disabled = cash;
        }
      }
    });
    if (!result.isConfirmed) return false;
    await Swal.fire({ title: result.value?.alreadyCollected ? 'Payment Already Recorded' : 'Payment Collected',
      text: result.value?.refreshFailed ? 'Payment is saved and awaiting admin remittance verification. The latest order details could not be loaded; refresh your orders when your connection returns.' : 'The customer payment is recorded. Admin will verify the remittance separately.',
      icon: result.value?.refreshFailed ? 'warning' : 'success' });
    return true;
  }

  window.TechnicianOrderPayment = {
    collect(id, onCollected) {
      if (pending.has(String(id))) return pending.get(String(id));
      const task = open(id, onCollected).finally(() => pending.delete(String(id)));
      pending.set(String(id), task);
      return task;
    }
  };
})();
