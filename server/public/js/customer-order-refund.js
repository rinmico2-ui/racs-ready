(function () {
  'use strict';
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-order-refund]').forEach(function (button) {
      button.addEventListener('click', async function () {
        if (button.disabled) return;
        button.disabled = true;
        const original = button.innerHTML;
        try {
          let reason;
          const explanation = 'The administrator will review the payment for this cancelled order. If your receipt is not verified yet, this submits a payment review request—not a confirmed refund. Money is never returned automatically.';
          if (window.Swal) {
            const result = await window.Swal.fire({ icon: 'question', title: 'Request a refund?', text: explanation,
              input: 'textarea', inputLabel: 'Reason for refund', inputAttributes: { maxlength: 500, 'aria-label': 'Reason for refund' },
              showCancelButton: true, confirmButtonText: 'Submit request', confirmButtonColor: '#2563eb',
              inputValidator: function (value) {
                const text = (value || '').trim();
                return text.length >= 10 && text.length <= 500 ? undefined : 'Enter a reason between 10 and 500 characters.';
              } });
            if (!result.isConfirmed) return;
            reason = result.value;
          } else {
            reason = window.prompt(explanation + '\nRefund reason (10–500 characters):');
            if (reason === null) return;
          }
          reason = String(reason || '').trim();
          if (reason.length < 10 || reason.length > 500) throw new Error('Enter a refund reason between 10 and 500 characters.');
          button.textContent = 'Submitting request...';
          const controller = new AbortController();
          const timeout = setTimeout(function () { controller.abort(); }, 30000);
          let response, data;
          try {
            response = await fetch('/api/orders/' + encodeURIComponent(button.dataset.orderRefund) + '/refund-request', {
              method: 'POST', credentials: 'same-origin', signal: controller.signal,
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ reason: reason }),
            });
            data = await response.json();
          } finally { clearTimeout(timeout); }
          if (!response.ok) throw new Error(data.error || 'Unable to submit the refund request.');
          if (window.Swal) await window.Swal.fire({ icon: 'info', title: data.refundReviewStatus === 'pending_verification' ? 'Payment review requested' : data.alreadyRequested ? 'Refund already recorded' : 'Refund request submitted', text: data.message });
          else window.alert(data.message);
          window.location.reload();
        } catch (error) {
          const message = error.name === 'AbortError' ? 'The request took too long. Refresh to check the refund status before retrying.' : error.message;
          if (window.Swal) await window.Swal.fire({ icon: 'error', title: 'Refund request unavailable', text: message });
          else window.alert(message);
        } finally {
          button.disabled = false;
          button.innerHTML = original;
        }
      });
    });
  });
})();
