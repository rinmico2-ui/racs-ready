# Application security remediation — 15 October 2026

This change addresses the findings in [the audit](security-audit-2026-10-15.md) and the registration flood shown in the activity log. It does not deploy code or change production infrastructure.

## Implemented

- Registration and Google signup have IP attempt ceilings of **5 per minute and 20 per 15 minutes**, enforced before request parsing, sessions, user creation or emails. Registration failures and pending successes both count. OTP resend/password-recovery endpoints share a separate email budget. MongoDB-backed atomic buckets preserve these ceilings across replicas and restarts; database errors fail closed. Local bounded counters reject repeated blocked requests without a database query. Rejection audit writes are bounded and sampled once per IP/category/minute.
- HTTP admission now precedes probes and static files, with configurable limits of 64 simultaneous requests, 24 per IP, and 600 requests per IP/minute. Direct local liveness/readiness probes bypass these ceilings. Expensive authentication work has a separate ceiling of eight globally/four per network, held until the work actually completes.
- Login, registration and password recovery/reset use HMAC-signed, CSRF-bound, purpose-specific challenges with ten-minute expiry and atomic single-use consumption. A posted `mathAnswer` is no longer authoritative. Forms submit the signed proof and refresh after errors; registration rate errors appear inline. Arithmetic remains easy for automation to solve: this is request integrity/replay protection, not a replacement for edge bot mitigation.
- Chatbot Markdown escapes quotes before forming link attributes. Raw JSON script data was hardened in 27 templates, and HTML attribute contexts use escaped EJS output. Catalog fallback parses an application/json element with JSON.parse rather than eval. These changes address the demonstrated stored/script-boundary and link-attribute injection paths.
- Remittance and project evidence downloads enforce record ownership, project assignment and relevant staff permissions. Malformed paths are rejected; private responses are not cached. Evidence-path lookup indexes were added.
- Local committed-sample QR/outbox secrets were replaced privately. Public sample values were removed from `.env.example`. Production startup and `npm run security:preflight` reject missing, short, reused or known sample secrets. Email key rotation supports a bounded previous-key reader so queued messages can drain. **Production secret configuration is still required before deployment.**
- Connected sockets periodically revalidate enabled accounts, login session, password change, role and effective permissions, including default-role policy edits. Idle connections are disconnected within the five-second check interval plus database time; packets trigger a shared overdue check and reject expired tokens. Both logout handlers disconnect the user's sockets immediately. Database refreshes are batched and coalesced.
- PayMongo webhook signatures require correctly sized signatures and timestamps within five minutes (with 30 seconds future clock allowance). Recognized events use a durable event ledger and shared leases; processing failures remain retryable. Source charges use a stable provider idempotency key and validate amount/currency. Payment updates are serialized per booking/order/payment, bound to the stored gateway resource, validate supplied amount/currency, and ignore failed events against terminal paid/verified/completed/refunded records. Source IDs are retained so a retry can finish an interrupted booking update without charging again.
- Public chat health no longer lists providers, model names, key counts, error details or session counts. General external AI requests omit the customer's structured booking/payment context and filter generated private account summaries from conversation history, including summaries echoed by the browser. Customer account-status queries retain their existing local response path. Customer chat has no database/file/shell execution tool. JSON text returned by AI does not itself execute a command.
- Permissions-Policy allows the application's camera/geolocation features while disabling unused microphone/payment/USB features. CSP no longer permits `unsafe-eval`. **`unsafe-inline` remains for legacy inline scripts/event handlers**; a complete nonce/handler migration is separate work. Session cookies retain HttpOnly; the XSRF cookie stays readable because the forms need it.
- Production dependency updates remove the ten production advisories found in the audit. The verified lockfile's `npm audit --omit=dev` reports zero vulnerabilities. This is a point-in-time dependency check, not a guarantee against every vulnerability.

## Deployment and verification

Follow [the step-by-step Dokploy guide](dokploy-security-steps.md). It covers the public MongoDB listener, provider firewall, internal database connection, secret rotation, proxy limits, Cloudflare Free, real visitor IP handling and safe post-deploy checks.

Regression verification uses isolated synthetic accounts, database mocks, payment events and a local browser. No production accounts, records, emails, payments or attendance entries were modified.

- **49 new regression tests passed.** The 150-request, changing-email signup fixture admitted only twenty attempts in its five-minute replay, and the initial 25-attempt/two-second replay admitted five. Other checks cover shared counters, storage failure, concurrent challenge replay, evidence ownership, socket revocation, secret rotation, webhook duplicates/recovery/resource binding, template output and private chat history.
- **Full suite: 2,105 passed, 0 failed, 0 skipped.** Final log: `temp/security-full-suite-verified.log`.
- Isolated Edge browser checks passed at **1440px and 390px** for signed login challenges, OTP queue/error handling, stale responses and administrator email-delivery UI. External requests were blocked and email endpoints were synthetic.
- The previously demonstrated browser injection markers now remain false. Cross-account project/remittance downloads return 403, anonymous downloads 401. A stale signed webhook and a challenge forged with a different QR signing key are rejected. No production credentials or financial events were used.
- Final `npm audit --omit=dev` reports **0 known production vulnerabilities**. Deployment secret preflight and whitespace checks pass. The browser and database mocks do not substitute for verifying the deployed server configuration.

## Remaining operator tasks

- Close and independently verify the origin's MongoDB port; an empty Dokploy External Port field alone is insufficient.
- Configure unique production secrets and rotate affected credentials if the pentesters provide evidence of actual exposure.
- Rebuild and deploy the updated application and lockfile; validate the new indexes and resource ceilings on the server.
- Configure edge/proxy filtering and verify real client IPs before changing proxy trust.
- Enable and restore-test an offsite database backup; the existing archive is not a configured backup job.
- Re-run the pentest against the deployed version. The scanner's health JSON, readable XSRF cookie and generic "defacement marker" do not establish an environment-file leak or successful compromise. Preserve evidence and investigate any precise exploit the evaluator can demonstrate.
