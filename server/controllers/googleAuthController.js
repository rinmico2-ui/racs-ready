const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { google } = require("googleapis");
const User = require("../models/User");
const AuthSession = require("../models/AuthSession");
const { isAccountEnabled } = require("../middleware/accountState");
const authController = require("./authController");

const OAUTH_COOKIE = "google_oauth_state";
const OAUTH_COOKIE_PATH = "/api/auth/google/callback";
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

function googleOAuthConfig() {
  const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
  const configuredRedirect = String(process.env.GOOGLE_OAUTH_REDIRECT_URI || "").trim();
  const baseUrl = String(
    process.env.APP_BASE_URL ||
    process.env.APP_URL ||
    `http://localhost:${process.env.PORT || 5000}`,
  ).replace(/\/$/, "");

  return {
    clientId,
    clientSecret,
    redirectUri: configuredRedirect || `${baseUrl}${OAUTH_COOKIE_PATH}`,
    enabled: Boolean(clientId && clientSecret),
  };
}

function oauthSigningSecret() {
  return process.env.SESSION_SECRET || process.env.JWT_SECRET;
}

function safeReturnTo(value) {
  if (typeof value !== "string" || value.length > 2048) return "";
  let candidate = value.trim();
  try {
    candidate = decodeURIComponent(candidate);
  } catch (err) {
    return "";
  }
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return "";
  return candidate;
}

function base64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function stateCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: OAUTH_STATE_TTL_SECONDS * 1000,
    path: OAUTH_COOKIE_PATH,
  };
}

function callbackError(res, code) {
  return res.redirect(303, `/login?google_error=${encodeURIComponent(code)}`);
}

function createOAuthClient(config) {
  return new google.auth.OAuth2({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
  });
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

exports.start = async (req, res, next) => {
  try {
    const config = googleOAuthConfig();
    if (!config.enabled) return callbackError(res, "not_configured");

    const state = base64Url(crypto.randomBytes(32));
    const nonce = base64Url(crypto.randomBytes(32));
    const codeVerifier = base64Url(crypto.randomBytes(64));
    const codeChallenge = base64Url(
      crypto.createHash("sha256").update(codeVerifier).digest(),
    );
    const stateToken = jwt.sign(
      {
        purpose: "google_oauth_login",
        state,
        nonce,
        codeVerifier,
        returnTo: safeReturnTo(req.query.returnTo),
      },
      oauthSigningSecret(),
      { algorithm: "HS256", expiresIn: OAUTH_STATE_TTL_SECONDS },
    );

    res.cookie(OAUTH_COOKIE, stateToken, stateCookieOptions());
    const authorizationUrl = createOAuthClient(config).generateAuthUrl({
      access_type: "online",
      scope: ["openid", "email", "profile"],
      prompt: "select_account",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return res.redirect(302, authorizationUrl);
  } catch (error) {
    return next(error);
  }
};

exports.callback = async (req, res) => {
  const config = googleOAuthConfig();
  const cookieOptions = stateCookieOptions();
  res.clearCookie(OAUTH_COOKIE, {
    httpOnly: cookieOptions.httpOnly,
    secure: cookieOptions.secure,
    sameSite: cookieOptions.sameSite,
    path: cookieOptions.path,
  });

  try {
    if (!config.enabled) return callbackError(res, "not_configured");

    const stateToken = req.cookies && req.cookies[OAUTH_COOKIE];
    const returnedState = String(req.query.state || "");
    if (!stateToken || !returnedState || returnedState.length > 256) {
      return callbackError(res, "invalid_request");
    }

    const oauthState = jwt.verify(stateToken, oauthSigningSecret(), {
      algorithms: ["HS256"],
    });
    if (oauthState.purpose !== "google_oauth_login") {
      return callbackError(res, "invalid_request");
    }
    const expectedState = Buffer.from(String(oauthState.state || ""));
    const actualState = Buffer.from(returnedState);
    if (
      expectedState.length !== actualState.length ||
      !crypto.timingSafeEqual(expectedState, actualState)
    ) {
      return callbackError(res, "invalid_request");
    }

    if (req.query.error) return callbackError(res, "cancelled");
    const code = String(req.query.code || "");
    if (!code || code.length > 4096 || !oauthState.codeVerifier) {
      return callbackError(res, "invalid_request");
    }

    const oauthClient = createOAuthClient(config);
    const { tokens } = await oauthClient.getToken({
      code,
      codeVerifier: oauthState.codeVerifier,
      redirect_uri: config.redirectUri,
    });
    if (!tokens.id_token) return callbackError(res, "invalid_account");

    const ticket = await oauthClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: config.clientId,
    });
    const profile = ticket.getPayload() || {};
    const email = String(profile.email || "").trim().toLowerCase();
    if (
      profile.email_verified !== true ||
      !email ||
      email.length > 254 ||
      profile.nonce !== oauthState.nonce
    ) {
      return callbackError(res, "invalid_account");
    }

    // Google login intentionally never provisions users. The email must already
    // belong to an active, verified account created through the normal workflow.
    const user = await User.findOne({ email });
    if (!user) return callbackError(res, "account_not_found");
    if (!isAccountEnabled(user)) return callbackError(res, "account_unavailable");

    await regenerateSession(req);
    req.session.userId = user._id.toString();
    req.session.role = user.role;
    req.session.createdAt = Date.now();
    req.session.lastActivity = Date.now();

    const redirect = await authController.establishJwtLogin(req, res, user, false, {
      method: "google",
      returnTo: safeReturnTo(oauthState.returnTo),
      sameSite: "lax",
    });

    try {
      await AuthSession.create({
        sessionId: req.sessionID,
        userId: user._id,
        ip: req.ip || "",
        userAgent: String(req.headers["user-agent"] || "").slice(0, 512),
      });
    } catch (error) {
      console.warn("googleAuth.callback: AuthSession create failed", error && error.message);
    }

    await saveSession(req);
    return res.redirect(303, redirect);
  } catch (error) {
    console.warn("Google sign-in failed", error && error.message);
    return callbackError(res, "failed");
  }
};

exports.isConfigured = function isConfigured() {
  return googleOAuthConfig().enabled;
};

exports._test = { googleOAuthConfig, safeReturnTo };
