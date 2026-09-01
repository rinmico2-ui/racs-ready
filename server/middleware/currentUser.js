const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { isAccountEnabled } = require("./accountState");

function parseCookies(header) {
  const h = header || "";
  return h
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const [k, ...v] = pair.split("=");
      acc[k] = decodeURIComponent(v.join("="));
      return acc;
    }, {});
}

module.exports = async function (req, res, next) {
  // always define `res.locals.user` so EJS can safely reference `user` (avoid ReferenceError)
  res.locals.user = null;
  try {
    const cookies = parseCookies(req.headers.cookie || "");
    const token = cookies["auth_token"];

    // Prefer JWT when present
    if (token) {
      try {
        const payload = jwt.verify(
          token,
          process.env.JWT_SECRET,
          { algorithms: ["HS256"] },
        );
        if (payload && payload.id) {
          const user = await User.findById(payload.id).select("-passwordHash");
          if (isAccountEnabled(user)) {
            try {
              if (
                payload.sessionId &&
                payload.sessionId !== String(user.currentSessionId || "")
              ) {
                // mismatch -> fall back to session below
              } else if (
                user.lastPasswordChange &&
                payload.iat &&
                payload.iat * 1000 < user.lastPasswordChange.getTime()
              ) {
                // Password changes invalidate previously issued tokens.
              } else {
                res.locals.user = user;
                req.user = user;
                return next();
              }
            } catch (e) {}
          }
        }
      } catch (e) {
        // invalid JWT -> fall back to session
      }
    }

    // Fallback: check express-session (server-side sessions)
    try {
      if (req && req.session && req.session.userId) {
        const sidUser = await User.findById(req.session.userId).select(
          "-passwordHash",
        );
        if (isAccountEnabled(sidUser)) {
          res.locals.user = sidUser;
          req.user = sidUser;
          return next();
        }
      }
    } catch (e) {}
  } catch (e) {
    // ignore - don't break anonymous pages
  }
  return next();
};
