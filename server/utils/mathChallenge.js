"use strict";
const crypto = require("crypto");
const AuthChallengeUse = require("../models/AuthChallengeUse");
const PURPOSES = new Set(["login", "register", "forgot", "reset"]);
const TTL_MS = 10 * 60 * 1000;

function hmac(value) {
  if (!process.env.JWT_SECRET) throw new Error("A signing secret is required for the security challenge.");
  return crypto.createHmac("sha256", process.env.JWT_SECRET).update(`math-challenge:${value}`).digest("hex");
}
function equal(left, right) {
  return typeof left === "string" && typeof right === "string" && /^[a-f0-9]{64}$/.test(left)
    && /^[a-f0-9]{64}$/.test(right) && crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
function issueMathChallenge(purpose, csrfToken, options = {}) {
  if (!PURPOSES.has(purpose) || !csrfToken) throw new Error("Invalid security challenge context.");
  const num1 = options.num1 ?? crypto.randomInt(10, 100);
  const num2 = options.num2 ?? crypto.randomInt(1, 10);
  const answer = num1 + num2;
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = { v: 1, purpose, nonce, expiresAt: (options.now ?? Date.now()) + TTL_MS,
    csrfHash: hmac(`csrf:${csrfToken}`), answerHash: hmac(`${nonce}:${purpose}:${answer}`),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { num1, num2, answer, challenge: `${encoded}.${hmac(encoded)}` };
}
function cookieToken(req) {
  if (req.cookies?.["XSRF-TOKEN"]) return req.cookies["XSRF-TOKEN"];
  const part = String(req.headers?.cookie || "").split(";").find(value => value.trim().startsWith("XSRF-TOKEN="));
  try { return part ? decodeURIComponent(part.trim().slice(11)) : ""; } catch { return ""; }
}
function invalid(message = "Your security question expired. Refresh it and try again.", status = 400) {
  return Object.assign(new Error(message), { status, code: "CAPTCHA_INVALID", refreshCaptcha: true, fields: { mathCaptcha: message } });
}
async function verifyMathChallenge(req, purpose, options = {}) {
  const raw = req.body?.mathChallenge;
  const answer = req.body?.mathCaptcha;
  const csrf = req.body?.csrfToken;
  if (typeof raw !== "string" || raw.length > 2048 || typeof answer !== "string" || !/^\d{1,3}$/.test(answer.trim())
    || typeof csrf !== "string" || !csrf || csrf !== cookieToken(req)) throw invalid();
  const [encoded, signature, extra] = raw.split(".");
  if (!encoded || extra || !equal(signature, hmac(encoded))) throw invalid();
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw invalid(); }
  const now = options.now ?? Date.now();
  if (payload.v !== 1 || payload.purpose !== purpose || !PURPOSES.has(purpose) || !/^[a-f0-9]{32}$/.test(payload.nonce)
    || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now || payload.expiresAt > now + TTL_MS + 30000
    || !equal(payload.csrfHash, hmac(`csrf:${csrf}`)) || !equal(payload.answerHash, hmac(`${payload.nonce}:${purpose}:${answer.trim()}`))) {
    throw invalid("Check the answer to the security question, or refresh it if it expired.");
  }
  try {
    await AuthChallengeUse.create({ _id: `${purpose}:${payload.nonce}`, expiresAt: new Date(payload.expiresAt + 60000) });
  } catch (error) {
    if (error.code === 11000) throw invalid("This security question was already used. Refresh it and try again.");
    throw invalid("Security checks are temporarily unavailable. Please try again shortly.", 503);
  }
  return true;
}
function sendChallengeError(res, error) {
  if (!error.refreshCaptcha) return false;
  res.status(error.status).json({ error: error.message, fields: error.fields, code: error.code, refreshCaptcha: true });
  return true;
}
module.exports = { issueMathChallenge, verifyMathChallenge, sendChallengeError, PURPOSES };
