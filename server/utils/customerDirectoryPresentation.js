'use strict';
const privacy = require('./logPrivacy');

// Positive projections and response allowlists keep account/security fields out
// of this directory, including fields added to User in the future.
const LIST_FIELDS = '_id firstName lastName email phone blocked vip createdAt accountStatus';
const DETAIL_FIELDS = LIST_FIELDS + ' lastLogin bookingLimit violations';
const CONTACT_FIELDS = '_id email phone address';
const string = value => String(value || '');
function maskPhone(value) {
  const digits = string(value).replace(/\D/g, '');
  return digits ? '***' + digits.slice(-4) : '';
}
function summary(user) {
  return { _id: string(user._id), firstName: string(user.firstName), lastName: string(user.lastName),
    email: privacy.maskEmail(user.email), phone: maskPhone(user.phone), blocked: user.blocked === true,
    vip: user.vip === true, createdAt: user.createdAt || null,
    accountStatus: user.accountStatus === 'invited' ? 'invited' : 'active' };
}
function violations(user) {
  return (Array.isArray(user.violations) ? user.violations : []).map(item => ({
    type: privacy.text(item.type || 'Account concern', 100),
    message: privacy.text(item.message || '', 1000), createdAt: item.createdAt || null,
  }));
}
function detail(user) {
  return { ...summary(user), lastLogin: user.lastLogin || null,
    bookingLimit: Math.max(0, Number(user.bookingLimit) || 0), violations: violations(user) };
}
function contact(user) {
  const address = user.address || {};
  return { email: string(user.email), phone: string(user.phone), address: {
    barangay: string(address.barangay), city: string(address.city),
    province: string(address.province), postalCode: string(address.postalCode),
  } };
}
module.exports = { LIST_FIELDS, DETAIL_FIELDS, CONTACT_FIELDS, summary, detail, contact, violations };
