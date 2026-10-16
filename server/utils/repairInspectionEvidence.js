'use strict';
const crypto = require('crypto');
const mongoose = require('mongoose');
const { imageMimeFromSignature, imageExtensionFor } = require('./uploadSecurity');
const MAX_BYTES = 5 * 1024 * 1024, MAX_FILES = 4;
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'repairInspectionEvidence' });
function validate(file) {
  const contentType = imageMimeFromSignature(file?.buffer);
  if (!Buffer.isBuffer(file?.buffer) || !file.buffer.length || file.buffer.length > MAX_BYTES || !contentType || contentType !== file.mimetype) {
    throw Object.assign(new Error('Use JPG, PNG or WEBP inspection photos up to 5 MB each.'), { status: 400 });
  }
  return contentType;
}
async function store(file, metadata) {
  const contentType = validate(file);
  const stream = bucket().openUploadStream(`inspection-${crypto.randomUUID()}${imageExtensionFor(file)}`, { metadata: { ...metadata, contentType } });
  try {
    await new Promise((resolve, reject) => { stream.once('error', reject); stream.once('finish', resolve); stream.end(file.buffer); });
    return stream.id;
  } catch (error) { await bucket().delete(stream.id).catch(() => {}); throw error; }
}
const remove = id => bucket().delete(new mongoose.Types.ObjectId(id));
const find = id => bucket().find({ _id: new mongoose.Types.ObjectId(id) }).next();
const download = id => bucket().openDownloadStream(new mongoose.Types.ObjectId(id));
module.exports = { MAX_BYTES, MAX_FILES, validate, store, remove, find, download };
