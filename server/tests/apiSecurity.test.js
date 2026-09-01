const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeOrigin,
  requireTrustedOrigin,
  trustedOriginsFor,
} = require("../middleware/apiSecurity");
const { isAccountEnabled } = require("../middleware/accountState");
const { imageExtensionFor, imageMimeFromSignature, isAllowedImage } = require("../utils/uploadSecurity");
const { escapeRegex } = require("../utils/stringSecurity");

function request({ method = "POST", origin, fetchSite, host = "app.example.test" } = {}) {
  const headers = { host };
  if (origin !== undefined) headers.origin = origin;
  if (fetchSite !== undefined) headers["sec-fetch-site"] = fetchSite;
  return {
    method,
    protocol: "https",
    get(name) {
      return headers[String(name).toLowerCase()];
    },
  };
}

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test("origin normalization rejects invalid values", () => {
  assert.equal(normalizeOrigin("https://example.test/path"), "https://example.test");
  assert.equal(normalizeOrigin("not a URL"), null);
});

test("same-origin unsafe API requests are accepted", () => {
  const req = request({ origin: "https://app.example.test" });
  const res = response();
  let called = false;
  requireTrustedOrigin(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
  assert.equal(trustedOriginsFor(req).has("https://app.example.test"), true);
});

test("cross-origin unsafe API requests are rejected", () => {
  const req = request({ origin: "https://attacker.example" });
  const res = response();
  let called = false;
  requireTrustedOrigin(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test("cross-site requests without an Origin header are rejected", () => {
  const req = request({ fetchSite: "cross-site" });
  const res = response();
  requireTrustedOrigin(req, res, () => assert.fail("next should not be called"));
  assert.equal(res.statusCode, 403);
});

test("safe methods do not require an Origin header", () => {
  const req = request({ method: "GET", fetchSite: "cross-site" });
  const res = response();
  let called = false;
  requireTrustedOrigin(req, res, () => { called = true; });
  assert.equal(called, true);
});

test("account state rejects disabled and blocked users", () => {
  assert.equal(isAccountEnabled({ active: true, blocked: false }), true);
  assert.equal(isAccountEnabled({ active: false, blocked: false }), false);
  assert.equal(isAccountEnabled({ active: true, blocked: true }), false);
  assert.equal(isAccountEnabled(null), false);
});

test("upload policy uses server-controlled image extensions", () => {
  assert.equal(imageExtensionFor({ mimetype: "image/jpeg", originalname: "proof.html" }), ".jpg");
  assert.equal(isAllowedImage({ mimetype: "image/svg+xml", originalname: "x.svg" }), false);
  assert.equal(isAllowedImage({ mimetype: "text/html", originalname: "x.jpg" }), false);
});

test("payment proof signatures must match a supported raster image", () => {
  assert.equal(imageMimeFromSignature(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(imageMimeFromSignature(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(imageMimeFromSignature(Buffer.from("RIFF0000WEBP", "ascii")), "image/webp");
  assert.equal(imageMimeFromSignature(Buffer.from("<script>alert(1)</script>")), null);
});

test("regex input is escaped and bounded", () => {
  assert.equal(escapeRegex("a.*(b)"), "a\\.\\*\\(b\\)");
  assert.equal(escapeRegex("x".repeat(200)).length, 100);
});
