const { issueMathChallenge } = require("../../utils/mathChallenge");
const AuthChallengeUse = require("../../models/AuthChallengeUse");
function install(test) {
  test.beforeEach(t => {
    process.env.JWT_SECRET ||= "isolated-auth-challenge-test-secret-32-characters";
    t.mock.method(AuthChallengeUse, "create", async () => ({}));
  });
}
function signedRequest(req, purpose) {
  req.headers ||= {};
  const csrf = req.body.csrfToken || "isolated-csrf-token";
  req.body.csrfToken = csrf;
  const cookie = `XSRF-TOKEN=${encodeURIComponent(csrf)}`;
  req.headers.cookie = (req.headers.cookie || "").replace(/(?:^|;\s*)XSRF-TOKEN=[^;]*/g, "");
  req.headers.cookie = [req.headers.cookie, cookie].filter(Boolean).join("; ");
  const answer = Number(req.body.mathAnswer || req.body.mathCaptcha);
  req.body.mathChallenge = issueMathChallenge(purpose, csrf, { num1: answer - 1, num2: 1 }).challenge;
  return req;
}
module.exports = { install, signedRequest };
