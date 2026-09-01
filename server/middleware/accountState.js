function isAccountEnabled(user) {
  return (
    Boolean(user) &&
    user.active !== false &&
    user.blocked !== true &&
    user.emailVerified !== false
  );
}

module.exports = { isAccountEnabled };
