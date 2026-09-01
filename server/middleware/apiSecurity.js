const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function normalizeOrigin(value) {
  if (!value) return null;
  try {
    return new URL(String(value)).origin;
  } catch (err) {
    return null;
  }
}

function trustedOriginsFor(req) {
  const origins = new Set();
  const requestOrigin = normalizeOrigin(`${req.protocol}://${req.get("host")}`);
  const appOrigin = normalizeOrigin(process.env.APP_URL);
  const baseOrigin = normalizeOrigin(process.env.APP_BASE_URL);
  if (requestOrigin) origins.add(requestOrigin);
  if (appOrigin) origins.add(appOrigin);
  if (baseOrigin) origins.add(baseOrigin);
  return origins;
}

function requireTrustedOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const originHeader = req.get("origin");
  const origin = normalizeOrigin(originHeader);
  const fetchSite = String(req.get("sec-fetch-site") || "").toLowerCase();

  if (originHeader && (!origin || !trustedOriginsFor(req).has(origin))) {
    return res.status(403).json({ error: "Cross-origin request rejected" });
  }
  if (!originHeader && fetchSite === "cross-site") {
    return res.status(403).json({ error: "Cross-origin request rejected" });
  }
  return next();
}

module.exports = { requireTrustedOrigin, normalizeOrigin, trustedOriginsFor };
