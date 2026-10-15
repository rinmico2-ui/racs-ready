"use strict";

module.exports = function sensitivePaths(req, res, next) {
  let pathname;
  try { pathname = decodeURIComponent(req.path).replace(/\\/g, "/"); } catch { return res.status(400).end(); }
  const segments = pathname.split("/");
  const secretPath = segments.some(segment => /^(?:\.env(?:\..*)?|\.git|\.svn|\.hg|node_modules)$/i.test(segment))
    || /\.(?:dump|archive(?:\.gz)?|bak|sql)$/i.test(pathname);
  if (!secretPath) return next();
  res.set("Cache-Control", "no-store");
  return res.status(404).end();
};
