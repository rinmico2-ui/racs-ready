(function () {
  'use strict';
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-order-reorder]').forEach(function (button) {
      button.addEventListener('click', async function () {
        if (button.disabled) return;
        const original = button.innerHTML;
        button.disabled = true;
        const text = 'Restore the original products to your cart using current prices and availability. Existing cart items stay. Your old payment and refund are not reused; you must review checkout and place a new order.';
        try {
          const confirmed = window.Swal
            ? (await window.Swal.fire({ icon: 'question', title: 'Reorder these products?', text: text,
                showCancelButton: true, confirmButtonText: 'Restore to cart', confirmButtonColor: '#2563eb' })).isConfirmed
            : window.confirm(text);
          if (!confirmed) return;
          button.textContent = 'Restoring to cart...';
          const controller = new AbortController();
          const timeout = setTimeout(function () { controller.abort(); }, 30000);
          let response;
          let data;
          try {
            response = await fetch('/api/orders/' + encodeURIComponent(button.dataset.orderReorder) + '/reorder', {
              method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller.signal,
            });
            data = await response.json();
          } finally {
            clearTimeout(timeout);
          }
          if (!response.ok) throw new Error(data.error || 'Unable to reorder. Please try again.');
          window.location.assign('/aircon-cart');
        } catch (error) {
          const message = error.name === 'AbortError'
            ? 'The request took too long. Check your cart or retry; retrying will not keep adding quantities.'
            : error.message || 'Unable to reorder. Please try again.';
          if (window.Swal) await window.Swal.fire({ icon: 'error', title: 'Reorder unavailable', text: message });
          else window.alert(message);
        } finally {
          button.disabled = false;
          button.innerHTML = original;
        }
      });
    });
  });
})();
