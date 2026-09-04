const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { isAccountEnabled } = require("./accountState");
const { getEffectivePermissions, requiredPermissionForRequest } = require("./requirePermission");

const MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_MS) || 30 * 60 * 1000;
const ROTATE_THRESHOLD_MS =
  Number(process.env.SESSION_ROTATE_THRESHOLD_MS) || 10 * 60 * 1000;

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
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (!payload || !payload.id) return null;
    const user = await User.findById(payload.id).select("-passwordHash");
    if (!isAccountEnabled(user)) return null;
    // verify server-side session binding
    if (
      payload.sessionId &&
      payload.sessionId !== String(user.currentSessionId || "")
    )
      return null;
    if (
      user.lastPasswordChange &&
      payload.iat &&
      payload.iat * 1000 < user.lastPasswordChange.getTime()
    )
      return null;
    return { user, payload };
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
    if (!isAccountEnabled(user)) return null;
    return { user, payload: null };
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
  const jwtAuth = await getUserFromToken(token);
  if (jwtAuth) return jwtAuth;

  // Fallback to server-side session login flow
  return getUserFromSession(req);
}

function refreshTokenIfNeeded(authResult, res) {
  const { user, payload } = authResult || {};
  if (!user || !payload || !payload.exp) return;
  if (payload.exp * 1000 - Date.now() >= ROTATE_THRESHOLD_MS) return;

  const rememberMe = Boolean(payload.rememberMe);
  const maxAge = rememberMe ? 30 * 24 * 60 * 60 * 1000 : MAX_AGE_MS;
  const renewedToken = jwt.sign(
    {
      id: user._id,
      role: user.role,
      sessionId: payload.sessionId,
      rememberMe,
    },
    process.env.JWT_SECRET,
    { expiresIn: Math.floor(maxAge / 1000) + "s" },
  );

  res.cookie("auth_token", renewedToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Strict",
    maxAge,
    path: "/",
  });
}

async function attachPermissionContext(user, req, res) {
  const permissions = await getEffectivePermissions(user);
  const permissionSet = new Set(permissions);
  res.locals.effectivePermissions = permissions;
  res.locals.can = (permission) => user.role === "admin" || permissionSet.has(permission);
  const requiredPermission = requiredPermissionForRequest(user, req);
  return {
    allowed: !requiredPermission || user.role === "admin" || permissionSet.has(requiredPermission),
    requiredPermission,
  };
}

module.exports = {
  requireLogin: async function (req, res, next) {
    const authResult = await getUserFromRequest(req);
    if (!authResult) {
      const returnTo = encodeURIComponent(req.originalUrl);
      return res.redirect("/login?returnTo=" + returnTo);
    }

    // Prevent browser back-cache from showing protected pages after logout.
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    refreshTokenIfNeeded(authResult, res);
    req.user = authResult.user;
    res.locals.user = authResult.user;
    const authorization = await attachPermissionContext(authResult.user, req, res);
    if (!authorization.allowed) {
      return res.redirect(`/access-denied?required=${encodeURIComponent(authorization.requiredPermission)}`);
    }
    next();
  },

  requireRole: function (roleOrRoles) {
    return async function (req, res, next) {
      const authResult = await getUserFromRequest(req);
      if (!authResult) {
        const returnTo = encodeURIComponent(req.originalUrl);
        return res.redirect("/login?returnTo=" + returnTo);
      }

      // Prevent browser back-cache from showing protected pages after logout.
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.set("Pragma", "no-cache");
      res.set("Expires", "0");

      const user = authResult.user;
      const allowed = Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles];
      if (!allowed.includes(user.role)) {
        if (user.role === "admin") return res.redirect("/profile-admin");
        if (user.role === "secretary") return res.redirect("/secretary/profile");
        if (user.role === "technician") return res.redirect("/technician");
        if (user.role === "customer") return res.redirect("/");
        return res.redirect("/access-denied");
      }
      refreshTokenIfNeeded(authResult, res);
      req.user = user;
      res.locals.user = user;
      const authorization = await attachPermissionContext(user, req, res);
      if (!authorization.allowed) {
        return res.redirect(`/access-denied?required=${encodeURIComponent(authorization.requiredPermission)}`);
      }
      next();
    };
  },

  requireCustomerOrGuest: async function (req, res, next) {
    const authResult = await getUserFromRequest(req);
    if (!authResult) {
      return next(); // Guest users are allowed
    }

    const user = authResult.user;

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

    refreshTokenIfNeeded(authResult, res);
    req.user = user;
    res.locals.user = user;
    next();
  },
};
