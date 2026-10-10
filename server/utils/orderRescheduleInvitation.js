const { REVIEWABLE_ORDER_STATUSES } = require('./orderAttention');

function activeOrderRescheduleInvitation(order, now = new Date()) {
  const invitation = order?.rescheduleInvitation;
  return REVIEWABLE_ORDER_STATUSES.has(order?.status) && invitation?.status === 'allowed'
    && new Date(invitation.expiresAt).getTime() > now.getTime();
}

function assertCustomerOrderReschedule(order, user, now = new Date()) {
  if (!order) throw Object.assign(new Error('Order not found.'), { status:404 });
  if (user?.role !== 'customer' || String(order.userId) !== String(user._id)) {
    throw Object.assign(new Error('Sign in with the customer account that owns this order.'), { status:403 });
  }
  if (!activeOrderRescheduleInvitation(order, now)) {
    throw Object.assign(new Error('This schedule link has expired or is no longer available. Contact us for help.'), { status:410 });
  }
  return order;
}

function finishOrderRescheduleInvitation(order, user) {
  if (order.rescheduleInvitation?.status !== 'allowed') return;
  // Mongoose includes this predicate in the final save, including a project transaction.
  // A concurrent cancellation or consumed invitation cannot be overwritten.
  order.$where = { ...(order.$where || {}), status:order.status };
  if (user.role === 'customer') Object.assign(order.$where, { userId:user._id,
    'rescheduleInvitation.status':'allowed', 'rescheduleInvitation.expiresAt':{ $gt:new Date() } });
  order.rescheduleInvitation.status = user.role === 'customer' ? 'submitted' : 'revoked';
  order.rescheduleInvitation.completedAt = new Date();
}

module.exports = { activeOrderRescheduleInvitation, assertCustomerOrderReschedule, finishOrderRescheduleInvitation };
