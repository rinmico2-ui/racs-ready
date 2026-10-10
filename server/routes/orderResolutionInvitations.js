const mongoose = require('mongoose');
const Order = require('../models/Order');
const { REVIEWABLE_ORDER_STATUSES } = require('../utils/orderAttention');
const { withOperationLock } = require('../utils/operationLock');
const { activeOrderRescheduleInvitation, assertCustomerOrderReschedule } = require('../utils/orderRescheduleInvitation');

module.exports = function installOrderResolutionInvitations(router, { authenticate, requireRole, availability, projectAvailability, saveSchedule }) {
  router.post('/:id/reschedule-invitation', authenticate, requireRole(['admin', 'secretary']), async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error:'Invalid order reference.' });
      const result = await withOperationLock(`order-resolution:${req.params.id}`, async () => {
        const order = await Order.findById(req.params.id);
        if (!order) throw Object.assign(new Error('Order not found.'), { status:404 });
        if (!REVIEWABLE_ORDER_STATUSES.has(order.status)) throw Object.assign(new Error('This order can no longer be rescheduled.'), { status:409 });
        if (!order.userId) throw Object.assign(new Error('This order needs a customer account before a schedule link can be sent.'), { status:409 });
        const now = new Date();
        const invitation = activeOrderRescheduleInvitation(order, now) ? order.rescheduleInvitation.toObject?.() || order.rescheduleInvitation
          : { status:'allowed', sentAt:now, expiresAt:new Date(now.getTime() + 7 * 86400000), sentBy:req.user._id };
        const saved = await Order.findOneAndUpdate({ _id:order._id, status:order.status, userId:order.userId },
          { $set:{ rescheduleInvitation:invitation } }, { returnDocument:'after', runValidators:true });
        if (!saved) throw Object.assign(new Error('This order changed. Refresh the queue before sending a link.'), { status:409 });
        return { order:saved, invitation };
      });
      const link = `/my-orders/${result.order._id}/reschedule`;
      const { createNotification } = require('../utils/notify');
      const notification = await createNotification({ type:'order_reschedule_invitation', title:'Choose a new order schedule',
        message:`Please choose a new ${result.order.fulfillmentType === 'customer_pickup' ? 'pickup date' : 'delivery schedule'} for ${result.order.orderReference || 'your aircon order'}. The link expires on ${new Date(result.invitation.expiresAt).toLocaleDateString('en-PH', { timeZone:'Asia/Manila' })}.`,
        userId:result.order.userId, role:'customer', referenceId:result.order._id, referenceModel:'Order', link, io:req.app.get('io') });
      let emailSent = false;
      try {
        const account = await require('../models/User').findById(result.order.userId).select('email').lean();
        if (account?.email) {
          const baseUrl = String(process.env.APP_BASE_URL || process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
          await require('../utils/mailer').sendMail({ to:account.email, subject:`Choose a new schedule · ${result.order.orderReference || 'Aircon order'}`,
            text:`Choose a new schedule for your aircon order: ${baseUrl}${link}\n\nSign in with your customer account. This link expires on ${new Date(result.invitation.expiresAt).toLocaleDateString('en-PH', { timeZone:'Asia/Manila' })}. For large installations, choose a start date and finish-by date.` });
          emailSent = true;
        }
      } catch (error) { console.warn('Order schedule invitation email could not be sent:', error.message); }
      if (!notification && !emailSent) return res.status(503).json({ error:'The schedule link is ready, but the customer could not be notified. Please retry.', link });
      return res.json({ success:true, message:emailSent ? notification ? 'Schedule link sent to the customer by email and account notification.' : 'Schedule link sent to the customer by email.' : 'Schedule link sent to the customer’s account notifications.', link, expiresAt:result.invitation.expiresAt, emailSent });
    } catch (error) { return res.status(Number(error.status) || 500).json({ error:error.message || 'Could not send the schedule link.' }); }
  });

  const ownedInvitation = handler => async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error:'Invalid order reference.' });
      assertCustomerOrderReschedule(await Order.findById(req.params.id), req.user);
      req.orderCustomerReschedule = true;
      return await handler(req, res);
    } catch (error) { return res.status(Number(error.status) || 500).json({ error:error.message || 'Could not open this schedule link.' }); }
  };
  router.get('/:id/customer-resolution-availability', authenticate, requireRole(['customer']), ownedInvitation(availability));
  router.post('/:id/customer-project-window-availability', authenticate, requireRole(['customer']), ownedInvitation(projectAvailability));
  router.post('/:id/customer-resolution-reschedule', authenticate, requireRole(['customer']), ownedInvitation(saveSchedule));
};
