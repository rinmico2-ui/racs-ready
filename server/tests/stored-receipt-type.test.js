'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Readable, PassThrough } = require('node:stream');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { resolveStoredReceiptType } = require('../utils/storedReceiptType');
const signatures = {
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/webp': Buffer.from('RIFF0000WEBP'), 'application/pdf': Buffer.from('%PDF-1.7'),
};
test('modern metadata and legacy MIME fields keep their supported file types without another read', async () => {
  for (const contentType of Object.keys(signatures)) {
    for (const file of [{ metadata: { contentType } }, { contentType }]) {
      assert.equal(await resolveStoredReceiptType(file, () => { throw Error('Unexpected header read'); }), contentType);
    }
  }
});
test('old receipts missing MIME are identified from at most sixteen original bytes, without rewriting them', async () => {
  for (const [type, bytes] of Object.entries(signatures)) {
    const file = { filename: 'wrong-extension.txt', length: 40712 }, before = JSON.stringify(file);
    let stream;
    const result = await resolveStoredReceiptType(file, options => {
      assert.deepEqual(options, { start: 0, end: 16 });
      stream = Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]); return stream;
    });
    assert.equal(result, type); assert.equal(JSON.stringify(file), before); assert.equal(stream.destroyed, true);
  }
});
test('invalid and empty files are rejected and PDFs remain excluded from image-only payment proof delivery', async () => {
  assert.equal(await resolveStoredReceiptType({ length: 8 }, () => Readable.from([Buffer.from('<script>')])), '');
  assert.equal(await resolveStoredReceiptType({ length: 0 }, () => { throw Error('Unexpected read'); }), '');
  assert.equal(await resolveStoredReceiptType({ length: 8 }, () => Readable.from([signatures['application/pdf']]), { allowPdf: false }), '');
});
test('failed storage reads remain errors and streams are closed', async () => {
  const stream = new Readable({ read() { this.destroy(new Error('Database temporarily unavailable')); } });
  await assert.rejects(resolveStoredReceiptType({ length: 50 }, () => stream), /Database temporarily unavailable/);
  assert.equal(stream.destroyed, true);
});

// Exercise the real booking proof handler with a missing-MIME GridFS fixture.
// No MongoDB connection, application startup, index creation or payment write.
function appointmentFixture({ allowed = true, bytes = signatures['image/jpeg'] } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../routes/appointmentRoutes.js'), 'utf8');
  const start = source.indexOf('router.get("/:id/payment-proof"');
  const end = source.indexOf('\n});', start) + 4;
  const headerCalls = [], full = new PassThrough(); full.pipe = destination => { full.destination = destination; };
  const file = { length: 40712 }, booking = { customerId: 'owner', paymentProofFileId: 'saved-file' };
  let handler, authorized = false;
  const context = {
    router: { get(_url, _auth, fn) { handler = fn; } }, auth: { authenticate() {} },
    mongoose: { Types: { ObjectId: { isValid: () => true } } },
    BookingService: { findById: () => ({ select: () => ({ lean: async () => booking }) }) },
    canAccessBooking: async () => { authorized = true; return allowed; },
    findPaymentProof: async () => file,
    openPaymentProofDownload: (_id, options) => { assert.equal(authorized, true); if (options) { headerCalls.push(options); return Readable.from([bytes]); } return full; },
    require: () => ({ resolveStoredReceiptType }),
  };
  vm.runInNewContext(source.slice(start, end), context);
  const response = { statusCode: 200, headers: {}, events: {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; }, set(headers) { Object.assign(this.headers, headers); }, on(name, fn) { this.events[name] = fn; } };
  return { headerCalls, full, response, call: () => handler({ params: { id: 'booking' }, user: { role: 'admin' } }, response, error => { throw error; }) };
}
test('the reported saved booking receipt is delivered as JPEG with private headers', async () => {
  const f = appointmentFixture(); await f.call();
  assert.equal(f.response.headers['Content-Type'], 'image/jpeg'); assert.equal(f.response.headers['Cache-Control'], 'private, no-store');
  assert.equal(f.response.headers['X-Content-Type-Options'], 'nosniff'); assert.equal(f.full.destination, f.response);
  assert.equal(f.headerCalls.length, 1); f.response.events.close(); assert.equal(f.full.destroyed, true);
});
test('booking ownership is checked before reading receipt bytes', async () => {
  const f = appointmentFixture({ allowed: false }); await f.call();
  assert.equal(f.response.statusCode, 403); assert.equal(f.headerCalls.length, 0); assert.equal(f.full.destination, undefined);
});
test('a stored invalid payment file returns 415 instead of streaming it as arbitrary data', async () => {
  const f = appointmentFixture({ bytes: Buffer.from('<html>Not a receipt</html>') }); await f.call();
  assert.equal(f.response.statusCode, 415); assert.equal(f.full.destination, undefined);
});
