const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { google } = require("googleapis");
const User = require("../models/User");
const AuthSession = require("../models/AuthSession");
const audit = require("../utils/audit");
const { getSystemConfiguration } = require("../utils/systemConfiguration");
const { isAccountEnabled } = require("../middleware/accountState");
const loginRateLimiter = require("../middleware/loginRateLimiter");
const authController = require("./authController");

const OAUTH_COOKIE = "google_oauth_state";
const OAUTH_COOKIE_PATH = "/api/auth/google/callback";
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const GOOGLE_SIGNUP_COOKIE = "google_signup_state";
const GOOGLE_SIGNUP_TTL_SECONDS = 30 * 60;

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

function isHttpsUrl(value) {
  try {
    return new URL(String(value || "")).protocol === "https:";
  } catch (error) {
    return false;
  }
}

function stateCookieOptions(config = googleOAuthConfig()) {
  return {
    httpOnly: true,
    // The OAuth state must survive the round trip through Google. Render can
    // terminate TLS before forwarding the request, so use the public callback
    // URL (not only NODE_ENV) to decide whether this is a secure cookie.
    secure:
      process.env.NODE_ENV === "production" || isHttpsUrl(config.redirectUri),
    sameSite: "lax",
    maxAge: OAUTH_STATE_TTL_SECONDS * 1000,
    path: OAUTH_COOKIE_PATH,
  };
}

function canonicalStartUrl(req, config) {
  try {
    const callbackOrigin = new URL(config.redirectUri).origin;
    const requestOrigin = new URL(`${req.protocol}://${req.get("host")}`).origin;
    if (callbackOrigin === requestOrigin) return "";

    const startUrl = new URL("/api/auth/google", callbackOrigin);
    const returnTo = safeReturnTo(req.query && req.query.returnTo);
    if (returnTo) startUrl.searchParams.set("returnTo", returnTo);
    return startUrl.toString();
  } catch (error) {
    return "";
  }
}

function callbackError(res, code) {
  return res.redirect(303, `/login?google_error=${encodeURIComponent(code)}`);
}

function signupCookieOptions(config = googleOAuthConfig()) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || isHttpsUrl(config.redirectUri),
    sameSite: "lax",
    maxAge: GOOGLE_SIGNUP_TTL_SECONDS * 1000,
    path: "/api/auth/google",
  };
}

function signupState(req) {
  const token = req.cookies && req.cookies[GOOGLE_SIGNUP_COOKIE];
  if (!token) return null;
  try {
    const state = jwt.verify(token, oauthSigningSecret(), { algorithms: ["HS256"] });
    return state.purpose === "google_customer_signup" && state.sub && state.email
      ? state
      : null;
  } catch (_) {
    return null;
  }
}

function cleanName(value) {
  const name = String(value || "").trim();
  return /^[A-Za-z\s]{1,20}$/.test(name) ? name : "";
}

function signupDetails(body) {
  const firstName = cleanName(body?.firstName);
  const lastName = cleanName(body?.lastName);
  const phone = String(body?.phone || "").replace(/\D/g, "");
  const province = String(body?.addressProvince || "").trim();
  const city = String(body?.addressCity || "").trim();
  const barangay = String(body?.addressBarangay || "").trim();
  const postalCode = String(body?.addressPostal || "").trim();
  if (!firstName || !lastName || !/^(?:0\d{10}|63\d{10}|9\d{9})$/.test(phone)
    || !province || province.length > 100 || !city || city.length > 100
    || !barangay || barangay.length > 100 || !/^\d{1,4}$/.test(postalCode)
    || body?.termsAccepted !== true) return null;
  return { firstName, lastName, phone, address: { province, city, barangay, postalCode } };
}

async function finishGoogleLogin(req, res, user, returnTo) {
  await regenerateSession(req);
  req.session.userId = user._id.toString();
  req.session.role = user.role;
  req.session.createdAt = Date.now();
  req.session.lastActivity = Date.now();

  const redirect = await authController.establishJwtLogin(req, res, user, false, {
    method: "google",
    returnTo: safeReturnTo(returnTo),
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
    console.warn("googleAuth: AuthSession create failed", error && error.message);
  }
  await saveSession(req);
  return redirect;
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

    // OAuth state cookies are scoped to a hostname. If somebody opens the
    // Render subdomain while the callback is configured for a custom domain,
    // start the flow on that custom domain so the callback receives the same
    // state cookie instead of failing as an expired/invalid request.
    const canonicalUrl = canonicalStartUrl(req, config);
    if (canonicalUrl) return res.redirect(302, canonicalUrl);

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
      !profile.sub ||
      String(profile.sub).length > 255 ||
      profile.nonce !== oauthState.nonce
    ) {
      return callbackError(res, "invalid_account");
    }

    const sub = String(profile.sub);
    const authoritativeEmail = email.endsWith("@gmail.com") || Boolean(profile.hd);
    const bySubject = await User.findOne({ googleSubject: sub }).select("+googleSubject");
    let user = bySubject;
    if (!user) user = await User.findOne({ email }).select("+googleSubject");
    if (user?.googleSubject && user.googleSubject !== sub) {
      return callbackError(res, "account_unavailable");
    }
    if (!bySubject && user && !authoritativeEmail) {
      return callbackError(res, "email_verification_required");
    }
    if (!user || user.emailVerified === false) {
      if (user && (user.role !== "customer" || user.accountOrigin !== "self_registration")) {
        return callbackError(res, "account_unavailable");
      }
      const policy = await getSystemConfiguration();
      if (!policy.application.allowCustomerRegistrations) {
        return callbackError(res, "registration_disabled");
      }
      // Google is not necessarily the current owner of a third-party email.
      // Gmail and Google Workspace identities can complete signup without
      // another email challenge; others use the existing email OTP workflow.
      if (!authoritativeEmail) {
        return callbackError(res, "email_verification_required");
      }
      const signupToken = jwt.sign({
        purpose: "google_customer_signup",
        sub,
        email,
        firstName: cleanName(profile.given_name),
        lastName: cleanName(profile.family_name),
        returnTo: safeReturnTo(oauthState.returnTo),
      }, oauthSigningSecret(), { algorithm: "HS256", expiresIn: GOOGLE_SIGNUP_TTL_SECONDS });
      res.cookie(GOOGLE_SIGNUP_COOKIE, signupToken, signupCookieOptions(config));
      return res.redirect(303, "/api/auth/google/signup");
    }
    if (!isAccountEnabled(user) || user.accountStatus === "invited") {
      return callbackError(res, "account_unavailable");
    }
    if (!user.googleSubject && user.role === "customer") {
      const linked = await User.updateOne({ _id: user._id, googleSubject: { $exists: false } }, {
        $set: { googleSubject: sub },
      });
      if (linked.matchedCount !== 1) return callbackError(res, "account_unavailable");
    }

    // A verified Google identity is a successful authentication. Clear stale
    // password/OTP failure counters so a prior typo cannot poison the next
    // legitimate sign-in from the same account or device.
    loginRateLimiter.reset("email", email);
    loginRateLimiter.reset(
      "ip_email",
      loginRateLimiter.scopedIpIdentifier(req.ip || "", email),
    );

    const redirect = await finishGoogleLogin(req, res, user, oauthState.returnTo);
    return res.redirect(303, redirect);
  } catch (error) {
    console.warn("Google sign-in failed", error && error.message);
    return callbackError(res, "failed");
  }
};

exports.signupPage = async (req, res) => {
  const state = signupState(req);
  if (!state) return callbackError(res, "signup_expired");
  res.set("Cache-Control", "no-store");
  return res.render("pages/googleSignup", {
    title: "Finish Google Sign Up | CALIDRO RACS",
    layout: "layouts/auth",
    email: state.email,
    firstName: state.firstName || "",
    lastName: state.lastName || "",
    extraScripts: ["/js/psgc-handler.js", "/js/google-signup.js"],
  });
};

exports.completeSignup = async (req, res, next) => {
  try {
    const state = signupState(req);
    if (!state) return res.status(401).json({ error: "Google signup expired. Please start again." });
    const policy = await getSystemConfiguration();
    if (!policy.application.allowCustomerRegistrations) {
      return res.status(403).json({ error: "New customer registration is temporarily unavailable." });
    }
    const details = signupDetails(req.body);
    if (!details) {
      return res.status(400).json({ error: "Complete your name, phone, address, and agreement." });
    }

    const bySubject = await User.findOne({ googleSubject: state.sub }).select("+googleSubject");
    const byEmail = await User.findOne({ email: state.email }).select("+googleSubject");
    if (bySubject && byEmail && String(bySubject._id) !== String(byEmail._id)) {
      return res.status(409).json({ error: "This Google account cannot be linked to that email." });
    }
    const user = bySubject || byEmail || new User({
      email: state.email,
      role: "customer",
      accountOrigin: "self_registration",
    });
    if (user.googleSubject && user.googleSubject !== state.sub) {
      return res.status(409).json({ error: "This email is linked to another Google account." });
    }
    if (user.role !== "customer" || user.accountStatus === "invited"
      || user.active === false || user.blocked === true) {
      return res.status(403).json({ error: "This account cannot use Google signup." });
    }
    if (user.emailVerified !== false && !user.isNew) {
      return res.status(409).json({ error: "This account already exists. Sign in with Google instead." });
    }
    if (!user.isNew && user.accountOrigin !== "self_registration") {
      return res.status(403).json({ error: "This account cannot use Google signup." });
    }

    user.googleSubject = state.sub;
    user.firstName = details.firstName;
    user.lastName = details.lastName;
    user.phone = details.phone;
    user.address = details.address;
    user.emailVerified = true;
    user.emailVerifiedAt = new Date();
    user.emailVerificationOtpHash = undefined;
    user.emailVerificationExpires = undefined;
    user.emailVerificationLastSentAt = undefined;
    user.emailVerificationAttempts = undefined;
    // A pending email signup may contain a password chosen by someone who did
    // not control the address. Replace it when Google proves the identity.
    await user.setPassword(crypto.randomBytes(32).toString("hex"));
    await user.save();
    const cookieOptions = signupCookieOptions();
    res.clearCookie(GOOGLE_SIGNUP_COOKIE, {
      httpOnly: cookieOptions.httpOnly,
      secure: cookieOptions.secure,
      sameSite: cookieOptions.sameSite,
      path: cookieOptions.path,
    });

    try {
      await audit.logEvent({
        actor: user._id,
        target: user._id,
        action: "USER_REGISTER",
        module: "auth",
        req,
        details: { method: "google", role: "customer" },
      });
    } catch (error) {
      console.warn("googleAuth.completeSignup: audit log failed", error && error.message);
    }

    const redirect = await finishGoogleLogin(req, res, user, state.returnTo);
    return res.status(201).json({ message: "Account created with Google.", redirect });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ error: "This account was already created. Sign in with Google." });
    }
    return next(error);
  }
};

exports.isConfigured = function isConfigured() {
  return googleOAuthConfig().enabled;
};

exports._test = {
  googleOAuthConfig,
  safeReturnTo,
  canonicalStartUrl,
  stateCookieOptions,
  signupCookieOptions,
  signupDetails,
  signupState,
};
