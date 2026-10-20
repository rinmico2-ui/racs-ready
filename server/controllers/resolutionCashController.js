'use strict';
function handler(source) {
  return async (req, res, next) => {
    try {
      const result = await require('../utils/resolutionPaymentPolicy').createService().confirm(source, req.params.id, req.body || {}, req.user);
      if (!result.duplicate) await require('../utils/audit').logEvent({ actor: req.user._id, target: req.params.id,
        action: 'resolution.cash_arrangement_confirmed', module: 'payments', req,
        details: { source, method: result.confirmation.method, amountDue: result.confirmation.amountDue, amountReceived: 0 },
      }).catch(() => {});
      res.json({ success: true, message: 'Cash arrangement confirmed. No payment has been recorded.' });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message, code: error.code || 'CASH_ARRANGEMENT_REVIEW_FAILED' });
      next(error);
    }
  };
}
module.exports = { booking: handler('booking'), order: handler('order') };
