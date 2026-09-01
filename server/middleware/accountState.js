function isAccountEnabled(user) {
  return Boolean(user) && user.active !== false && user.blocked !== true;
}

module.exports = { isAccountEnabled };
