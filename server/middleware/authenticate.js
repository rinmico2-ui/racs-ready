const jwt = require("jsonwebtoken");
const User = require("../models/User");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
// Sliding session: keep relatively short expiry and rotate on activity
const MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_MS) || 30 * 60 * 1000; // 30 minutes
const ROTATE_THRESHOLD_MS =
  Number(process.env.SESSION_ROTATE_THRESHOLD_MS) || 10 * 60 * 1000; // rotate if <10 minutes left

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

module.exports = {
  authenticate: async function (req, res, next) {
    try {
      const cookies = parseCookies(req.headers.cookie || "");
      const token = cookies["auth_token"];
      // diagnostic logging for location tracker / other API calls
      if (req.path && req.path.includes("technician/location")) {
        console.log(
          "authenticate middleware: incoming cookies",
          req.headers.cookie,
        );
      }

      let user = null;
      let payload = null;
      if (token) {
        try {
          payload = jwt.verify(token, JWT_SECRET);
          user = await User.findById(payload.id).select("-passwordHash");
          // if token stored sessionId check as before
          if (
            user &&
            payload.sessionId &&
            user.currentSessionId &&
            payload.sessionId !== user.currentSessionId
          ) {
            user = null;
          }
          if (
            user &&
            user.lastPasswordChange &&
            payload.iat &&
            payload.iat * 1000 < user.lastPasswordChange.getTime()
          ) {
            user = null;
          }
        } catch (e) {
          user = null;
          payload = null;
        }
      }

      // if no JWT user, try express-session fallback
      if (!user && req.session && req.session.userId) {
        try {
          user = await User.findById(req.session.userId).select(
            "-passwordHash",
          );
        } catch (e) {
          user = null;
        }
      }

      if (!user) {
        if (req.path && req.path.includes("technician/location")) {
          console.warn(
            "authenticate: unable to identify user from token/session",
          );
          return res.status(401).json({
            error: "Not authenticated",
            debug: { cookieHeader: req.headers.cookie || null },
          });
        }
        return res.status(401).json({ error: "Not authenticated" });
      }

      // verify server-side session binding (optional but recommended)
      if (payload) {
        if (
          payload.sessionId &&
          user.currentSessionId &&
          payload.sessionId !== user.currentSessionId
        ) {
          res.clearCookie("auth_token", { path: "/" });
          return res.status(401).json({ error: "Not authenticated" });
        }

        // If the user's password was changed after token was issued, reject the token
        if (
          user.lastPasswordChange &&
          payload.iat &&
          payload.iat * 1000 < user.lastPasswordChange.getTime()
        ) {
          res.clearCookie("auth_token", { path: "/" });
          return res.status(401).json({ error: "Not authenticated" });
        }
      }

      req.user = user;
      // expose to templates
      try {
        res.locals.user = user;
      } catch (e) {}

      // sliding session: rotate token when close to expiry to implement inactivity extension
      if (payload) {
        const expMs = (payload.exp || 0) * 1000;
        if (expMs - Date.now() < ROTATE_THRESHOLD_MS) {
          // Preserve sessionId when rotating token
          const newToken = jwt.sign(
            { id: user._id, role: user.role, sessionId: user.currentSessionId },
            JWT_SECRET,
            { expiresIn: Math.floor(MAX_AGE_MS / 1000) + "s" },
          );
          const isProd = process.env.NODE_ENV === "production";
          res.cookie("auth_token", newToken, {
            httpOnly: true,
            secure: isProd,
            sameSite: "Strict",
            maxAge: MAX_AGE_MS,
            path: "/",
          });
        }
      }

      next();
    } catch (err) {
      next(err);
    }
  },

  requireRole: function (roleOrRoles) {
    return function (req, res, next) {
      if (!req.user)
        return res.status(401).json({ error: "Not authenticated" });
      const allowed = Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles];
      if (!allowed.includes(req.user.role))
        return res.status(403).json({ error: "Forbidden" });
      next();
    };
  },
};
