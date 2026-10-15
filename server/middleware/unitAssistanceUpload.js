'use strict';
const multer = require('multer');
const { isAllowedImage } = require('../utils/uploadSecurity');
const { MAX_PHOTO_BYTES, validatePhoto } = require('../utils/unitAssistancePhotos');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 2, fields: 15, fieldSize: 8192 },
  fileFilter: (_req, file, cb) => cb(isAllowedImage(file) ? null : new Error('Use JPG, PNG, or WEBP photos.'), isAllowedImage(file)) }).array('photos', 2);
module.exports = (req, res, next) => {
  if (!req.is('multipart/form-data')) return next();
  upload(req, res, error => {
    if (error) return res.status(400).json({ error: 'Upload up to two JPG, PNG, or WEBP photos, 5 MB each.' });
    try {
      (req.files || []).forEach(validatePhoto);
      if (req.body.relocation) req.body.relocation = JSON.parse(req.body.relocation);
      next();
    } catch (_) { return res.status(400).json({ error: 'Check your photos and unit details before sending the request.' }); }
  });
};
