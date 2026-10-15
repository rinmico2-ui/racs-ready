"use strict";

const fs = require("node:fs");
const path = require("node:path");
const BACKUP_NAME = /^booking-order-reset-\d{13}-[a-f0-9]{8}\.ejson(?:\.sha256)?$/;

function createResetBackupDownload({ directory = path.resolve(__dirname, "../../temp") } = {}) {
  return async function resetBackupDownload(req, res) {
    res.set("Cache-Control", "private, no-store");
    res.set("X-Content-Type-Options", "nosniff");
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Administrator access is required." });
    const filename = req.params.filename;
    if (typeof filename !== "string" || !BACKUP_NAME.test(filename)) return res.status(404).json({ error: "Recovery backup not found." });
    const file = path.join(directory, filename);
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return res.status(404).json({ error: "Recovery backup not found." });
      res.set("Content-Type", "application/octet-stream");
      return res.download(file, filename, { dotfiles: "deny", cacheControl: false }, error => {
        if (!error) return;
        if (!res.headersSent) res.status(404).json({ error: "Recovery backup not found." });
        else res.destroy();
      });
    } catch {
      return res.status(404).json({ error: "Recovery backup not found." });
    }
  };
}

module.exports = { BACKUP_NAME, createResetBackupDownload };
