'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const mongoose = require('mongoose'), storage = require('../utils/repairInspectionEvidence');
const png = { buffer: Buffer.from('89504e470d0a1a0a00000000', 'hex'), mimetype: 'image/png', originalname: 'inspection.png' };

test('inspection evidence rejects spoofed images, empty uploads and oversized files', () => {
  assert.equal(storage.validate(png), 'image/png');
  for (const file of [undefined, { ...png, buffer: Buffer.alloc(0) }, { ...png, buffer: Buffer.from('<script>not an image</script>') }, { ...png, mimetype:'image/jpeg' }, { ...png, buffer:Buffer.alloc(storage.MAX_BYTES+1) }]) assert.throws(() => storage.validate(file), /JPG, PNG or WEBP/);
});

test('inspection evidence stores exact bytes and durable ownership and MIME metadata in GridFS', async t => {
  const original = mongoose.connection.db; mongoose.connection.db = {}; t.after(() => { mongoose.connection.db = original; });
  const fileId = new mongoose.Types.ObjectId(), chunks = []; let saved;
  t.mock.getter(mongoose.mongo, 'GridFSBucket', () => function(db, options) {
    assert.equal(options.bucketName, 'repairInspectionEvidence');
    return { openUploadStream(name, options) {
      assert.match(name,/^inspection-.*\.png$/); saved = options;
      const stream = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk); callback(); } }); stream.id=fileId; return stream;
    } };
  });
  const metadata={scope:'booking',documentId:'booking',unitKey:'G1-U001',uploadedBy:'technician'};
  assert.equal(await storage.store(png,metadata),fileId);
  assert.deepEqual(Buffer.concat(chunks),png.buffer);
  assert.deepEqual(saved.metadata,{...metadata,contentType:'image/png'});
});

test('a failed evidence upload removes its partial GridFS file', async t => {
  const original=mongoose.connection.db;mongoose.connection.db={};t.after(()=>{mongoose.connection.db=original;});
  const fileId=new mongoose.Types.ObjectId(), removed=[];
  t.mock.getter(mongoose.mongo,'GridFSBucket',()=>function(){return{
    openUploadStream(){const stream=new Writable({write(chunk,encoding,callback){callback(Error('Upload interrupted'));}});stream.id=fileId;return stream;},
    async delete(id){removed.push(id);},
  };});
  await assert.rejects(storage.store(png,{}),/Upload interrupted/);assert.deepEqual(removed,[fileId]);
});
