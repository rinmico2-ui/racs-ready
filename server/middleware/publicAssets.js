const express = require('express');
const path = require('path');

// Only application assets bypass database-backed sessions. /uploads is
// deliberately excluded: its evidence and payment files remain authenticated.
module.exports = function publicAssets(publicDirectory) {
  const router = express.Router();
  for (const directory of ['css', 'js', 'images', 'vendor']) {
    router.use('/' + directory, express.static(path.join(publicDirectory, directory), {
      etag: true,
      lastModified: true,
      dotfiles: 'deny',
      index: false,
      setHeaders(res, filePath) {
        if (process.env.NODE_ENV !== 'production') return;
        const media = /\.(?:avif|gif|ico|jpe?g|png|svg|webp|woff2?)$/i.test(filePath);
        res.setHeader('Cache-Control', media ? 'public, max-age=2592000' : 'public, max-age=3600');
      },
    }));
  }
  return router;
};
