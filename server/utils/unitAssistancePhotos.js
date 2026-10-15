'use strict';
const crypto = require('crypto'), mongoose = require('mongoose');
const { imageMimeFromSignature, imageExtensionFor } = require('./uploadSecurity');
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
function validatePhoto(file) {
  const mime = imageMimeFromSignature(file?.buffer);
  if (!file?.buffer?.length || file.buffer.length > MAX_PHOTO_BYTES || !mime || mime !== file.mimetype) {
    throw Object.assign(new Error('Use JPG, PNG, or WEBP photos up to 5 MB each.'), { status: 400 });
  }
  return mime;
}
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'unitAssistancePhotos' });
async function storePhoto(file, customerId) {
  const contentType = validatePhoto(file);
  const stream = bucket().openUploadStream(`unit-${crypto.randomUUID()}${imageExtensionFor(file)}`, { contentType, metadata: { customerId: String(customerId) } });
  try {
    await new Promise((resolve, reject) => { stream.once('error', reject); stream.once('finish', resolve); stream.end(file.buffer); });
    return { fileId: stream.id, contentType, length: file.buffer.length };
  } catch (error) { await bucket().delete(stream.id).catch(() => {}); throw error; }
}
const deletePhoto = fileId => bucket().delete(fileId);
const downloadPhoto = fileId => bucket().openDownloadStream(fileId);
module.exports = { MAX_PHOTO_BYTES, validatePhoto, storePhoto, deletePhoto, downloadPhoto };
