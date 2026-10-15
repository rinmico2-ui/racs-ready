(function () {
  'use strict';
  window.ProjectPurchaseHandover = {
    collectSerials: function (summary) {
      if (!summary.sourceOrderId) return Promise.resolve(null);
      return new Promise(resolve => {
        const trigger = document.activeElement;
        const overlay = document.createElement('div'); overlay.className = 'pw-modal-overlay';
        const panel = document.createElement('div'); panel.className = 'pw-pay-modal'; panel.style.background = '#fff'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'purchaseSerialTitle');
        const header = document.createElement('div'); header.className = 'pw-pay-header'; header.style.background = '#f8fafc';
        const title = document.createElement('h5'); title.id = 'purchaseSerialTitle'; title.textContent = 'Record installed aircon serial numbers';
        const description = document.createElement('p'); description.textContent = (summary.orderReference || 'Product purchase') + ': record one serial number per installed unit for handover, warranty and maintenance.';
        header.append(title, description);
        const body = document.createElement('div'); body.className = 'pw-pay-body'; body.style.maxHeight = '55vh'; body.style.overflowY = 'auto';
        const inputs = [];
        for (const item of summary.purchaseItems || []) for (let index = 1; index <= Number(item.quantity); index++) {
          const label = document.createElement('label'); label.style.cssText = 'display:block;margin-bottom:12px;font-size:.8rem';
          label.textContent = [item.brand, item.modelLine, item.capacity && item.capacity + ' ' + (item.capacityUnit || 'HP')].filter(Boolean).join(' ') + ' - Unit ' + index;
          const input = document.createElement('input'); input.className = 'form-control mt-1'; input.required = true; input.maxLength = 120; input.autocomplete = 'off'; input.dataset.purchaseSerial = String(inputs.length); input.setAttribute('aria-label', label.textContent + ' serial number');
          input.style.minHeight = '44px'; label.appendChild(input); body.appendChild(label); inputs.push(input);
        }
        const message = document.createElement('p'); message.setAttribute('role', 'alert'); message.style.color = '#dc2626'; body.appendChild(message);
        const footer = document.createElement('div'); footer.className = 'pw-pay-footer';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'pw-btn'; cancel.textContent = 'Cancel';
        const next = document.createElement('button'); next.type = 'button'; next.className = 'pw-btn success'; next.textContent = 'Continue handover';
        cancel.style.minHeight = next.style.minHeight = '44px';
        const close = value => { document.removeEventListener('keydown', trap); overlay.remove(); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); resolve(value); };
        function trap(event) {
          if (event.key === 'Escape') { event.preventDefault(); close(null); }
          if (event.key === 'Tab') {
            const first = inputs[0] || cancel;
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); next.focus(); }
            else if (!event.shiftKey && document.activeElement === next) { event.preventDefault(); first.focus(); }
          }
        }
        cancel.addEventListener('click', () => close(null));
        next.addEventListener('click', () => {
          const serials = inputs.map(input => input.value.trim());
          const missing = inputs.find(input => !input.value.trim());
          if (missing) { message.textContent = 'Enter a serial number for every installed aircon.'; missing.focus(); return; }
          if (new Set(serials.map(serial => serial.toLowerCase())).size !== serials.length) { message.textContent = 'Each aircon must have a unique serial number.'; return; }
          close(serials);
        });
        footer.append(cancel, next); panel.append(header, body, footer); overlay.appendChild(panel); document.body.appendChild(overlay);
        document.addEventListener('keydown', trap); inputs[0]?.focus();
      });
    }
  };
})();
