const jwt = require("jsonwebtoken");
const User = require("../models/User");

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

async function getUserFromToken(token) {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
    if (!payload || !payload.id) return null;
    const user = await User.findById(payload.id).select("-passwordHash");
    if (!user) return null;
    // verify server-side session binding
    if (
      payload.sessionId &&
      user.currentSessionId &&
      payload.sessionId !== user.currentSessionId
    )
      return null;
    if (
      user.lastPasswordChange &&
      payload.iat &&
      payload.iat * 1000 < user.lastPasswordChange.getTime()
    )
      return null;
    return user;
  } catch (e) {
    return null;
  }
}

async function getUserFromSession(req) {
  try {
    if (!req || !req.session || !req.session.userId) return null;
    const user = await User.findById(req.session.userId).select(
      "-passwordHash",
    );
    if (!user) return null;
    return user;
  } catch (e) {
    return null;
  }
}

async function getUserFromRequest(req) {
  const cookies = parseCookies(
    (req && req.headers && req.headers.cookie) || "",
  );
  const token = cookies["auth_token"];

  // Prefer JWT token when present
  const jwtUser = await getUserFromToken(token);
  if (jwtUser) return jwtUser;

  // Fallback to server-side session login flow
  return getUserFromSession(req);
}

module.exports = {
  requireLogin: async function (req, res, next) {
    const user = await getUserFromRequest(req);
    if (!user) {
      const returnTo = encodeURIComponent(req.originalUrl);
      return res.redirect("/login?returnTo=" + returnTo);
    }

    // Prevent browser back-cache from showing protected pages after logout.
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    req.user = user;
    res.locals.user = user;
    next();
  },

  requireRole: function (roleOrRoles) {
    return async function (req, res, next) {
      const user = await getUserFromRequest(req);
      if (!user) {
        const returnTo = encodeURIComponent(req.originalUrl);
        return res.redirect("/login?returnTo=" + returnTo);
      }

      // Prevent browser back-cache from showing protected pages after logout.
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.set("Pragma", "no-cache");
      res.set("Expires", "0");

      const allowed = Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles];
      if (!allowed.includes(user.role)) {
        if (user.role === "admin") return res.redirect("/profile-admin");
        if (user.role === "secretary") return res.redirect("/secretary/profile");
        if (user.role === "technician") return res.redirect("/technician");
        if (user.role === "customer") return res.redirect("/");
        return res.redirect("/access-denied");
      }
      req.user = user;
      res.locals.user = user;
      next();
    };
  },

  requireCustomerOrGuest: async function (req, res, next) {
    const user = await getUserFromRequest(req);
    if (!user) {
      return next(); // Guest users are allowed
    }

    if (user.role !== "customer") {
      // Prevent browser back-cache
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.set("Pragma", "no-cache");
      res.set("Expires", "0");

      if (user.role === "admin") return res.redirect("/profile-admin");
      if (user.role === "secretary") return res.redirect("/secretary/profile");
      if (user.role === "technician") return res.redirect("/technician");
      return res.redirect("/access-denied");
    }

    req.user = user;
    res.locals.user = user;
    next();
  },
};
