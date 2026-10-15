# System security audit — October 15, 2026

# Remediation update

Application fixes and their verification are recorded in [the remediation report](security-remediation-2026-10-15.md). Follow [the Dokploy server instructions](dokploy-security-steps.md) for the remaining infrastructure work. This audit below describes the original findings; it does not certify the updated application is deployed or that the public database port has been closed.

Date is in Asia/Manila. This review covers the current workspace and limited read-only checks of `https://racsready.its-au.space/`. It does not change application code, dependencies, credentials, database records, or Dokploy settings. New files are audit notes and isolated diagnostic fixtures.

**The system has unresolved security issues.** The highest priorities are the public MongoDB port, browser output encoding, proof-file ownership, vulnerable dependencies, and sample secrets reused in configuration. Some screenshot findings are observations or false-positive candidates rather than demonstrated compromises.

## Scope and evidence

- Inventoried 44 route modules and 1,089 literal route declarations. This is a route inventory, not a claim that every endpoint and dynamic registration received an independent exploit test.
- Scanned 1,012 tracked text files and 3,184 unique historical text blobs, across the repository's 114 commits. Matched 17 currently configured secret values without displaying them, and checked common literal provider-key formats and database URI patterns.
- Reviewed authentication, session cookies, CSRF/origin checks, permission middleware, customer record scoping, chat prompts and rendering, upload delivery, payment webhook verification, WebSocket authentication, production database configuration, and request admission controls.
- Made 20 low-volume HTTP GET checks. Recorded status, headers, field names, and credential-detection flags; retained no response bodies or customer records.
- Confirmed MongoDB on the reported public port with an unauthenticated `hello` handshake. Separately checked read authorization against a synthetic nonexistent collection, with an impossible match and a one-result limit. The command returned authorization error 13. No application records were requested or returned, and no collections were created.
- Reproduced browser execution and file-authorization issues in an isolated local server using synthetic data. No model jailbreak requests, production uploads, payment events, attendance records, or emails were sent.
- Ran `npm audit --omit=dev` against the local dependency tree/lockfile. Deployed container package versions have not been inspected.
- Ran 136 existing focused security, authentication, privacy, role, ownership, and traffic tests in three disjoint batches: all passed. Existing tests passing does not cover the newly reproduced vulnerabilities. The previous complete suite run passed 2,056 tests; application code has not changed during this audit.

## Prioritized findings

| ID | Priority | Finding | Evidence status |
|---|---|---|---|
| S01 | High | Public MongoDB on port 27017 | Confirmed live; unauthenticated read denied |
| S02 | High | Executable chatbot Markdown attributes | Harmless browser execution reproduced locally |
| S03 | High | Raw catalog JSON can escape its script element | Harmless browser execution reproduced locally |
| S04 | High | Missing ownership checks on several proof-file paths | Cross-user synthetic file access reproduced locally |
| S05 | High | Configured QR/outbox secrets match committed example values | Confirmed locally and in Git; production values unknown |
| S06 | High | Production dependency advisories | Confirmed local package versions; exploit conditions vary |
| S07 | Medium | Math CAPTCHA compares two client-controlled values | Confirmed in controller logic |
| S08 | Medium | Established WebSockets lack ongoing revocation checks | Confirmed in reviewed connection/packet paths |
| S09 | Medium | Gateway webhook signatures have no freshness bound | Synthetic signature with epoch timestamp accepted locally |
| S10 | Low | Public AI health endpoint exposes operational details | Confirmed live; no API key values detected |
| S11 | Low | Missing Permissions-Policy; broad inline/eval CSP allowances | Confirmed live; inline execution amplifies S02/S03 |

No unauthenticated database record access, `.env` download, or site defacement was demonstrated by these checks.

### S01 — Public MongoDB port

The site's public host responds as MongoDB on **27017**. This is different from the older locally configured **12131**, which refused the audit connection. The earlier endpoint check therefore did not close the port-27017 finding.

The anonymous read-authorization test returned `MongoServerError`, code **13** (Unauthorized). This establishes authentication enforcement for that tested namespace/command. It does not establish correct privileges for authenticated application users or audit every database's configuration.

The owner reports an empty External Port field in the native Dokploy MongoDB service. That UI field does not explain which running service or host process currently owns port 27017. Another service, a stale published mapping, or a host MongoDB process must be checked by the server operator.

**Remediation:** identify the listener and remove its public publication while keeping the application's authenticated internal connection working. Use MongoDB's private Docker service hostname and internal port 27017. Preserve authorization and the database volume. Use a dedicated application user with only the necessary database permissions. If remote management is required, use an authenticated private network/tunnel rather than a generally reachable port. Do not assume that changing the application URI or the displayed External Port field closes a different listener.

An operator can inspect only the relevant ports and service names, without printing environment variables or credentials:

```sh
ss -lntp '( sport = :27017 or sport = :12131 )'
docker service ls --format 'table {{.Name}}\t{{.Ports}}'
docker ps --format 'table {{.Names}}\t{{.Ports}}'
docker service inspect templates-emak-q9jqps --format '{{json .Endpoint.Spec.Ports}}'
```

Substitute the actual service name when different. Correct the owning service's configuration and verify that the application remains healthy on its internal connection. Then repeat an outside-server connection check to 27017: it should be refused or time out. Container port publication must be checked directly; a host firewall setting alone is not proof that published Docker ports are inaccessible.

MongoDB recommends trusted networks, access control, and restricting network exposure: [self-managed security checklist](https://www.mongodb.com/docs/manual/administration/security-checklist/). Dokploy distinguishes internal and internet-facing database connections: [connection documentation](https://docs.dokploy.com/docs/core/databases/connection).

### S02 — Chatbot link attribute injection

Source: `server/views/partials/chatbot.ejs`, `formatMarkdown`, `inlineFormat`, and `escapeHtml` (approximately lines 1606–1734).

Raw model text is escaped through a text node, which protects ordinary HTML content. However, that escaping does not encode quotation marks for an HTML attribute. The Markdown link formatter later places the URL directly inside a quoted `href`. A URL beginning with an allowed `/` can contain a quote that introduces an event-handler attribute.

The local test used the actual formatter functions and the site's allowed inline-script behavior. A synthetic Markdown link created an `onclick` attribute and set a harmless browser variable when clicked. There was no external request or credential access.

This is an output-handling vulnerability. Producing JSON or changing the AI's response format is not itself an exploit. The dangerous step is treating untrusted generated content as executable HTML. A model response, poisoned catalog text, or another untrusted input source can supply such content; an end-to-end model attack against production was not attempted.

**Remediation:** build links through DOM APIs or a vetted Markdown renderer and sanitizer. Validate parsed URL schemes/origins where appropriate. Encode values for their actual HTML attribute context; ordinary text escaping is insufficient. Preserve safe same-origin navigation and `noopener` behavior. Add a regression that verifies malicious quote-containing URLs cannot create event attributes, scripts, or unintended elements. Strengthen CSP as a separate protection.

OWASP requires treating model output as untrusted and keeping authorization outside the model: [prompt-injection prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html).

### S03 — Raw JSON in script elements

Sources:

- `server/views/partials/aircons.ejs:2010`: `GROUPS` uses raw `JSON.stringify(airconGroups)` inside executable JavaScript.
- `server/views/pages/services.ejs:78`: initial service data uses raw JSON inside an `application/json` script element.
- `server/views/pages/services.ejs:85`: service categories are serialized into an executable script.

`JSON.stringify` does not escape the HTML parser's `</script>` boundary. Even a script tagged `application/json` can be terminated by that sequence. A stored catalog string containing it can introduce a second script element.

The exact aircon serializer was rendered locally with a synthetic model name. The injected second script set a harmless marker. No catalog record was changed. Ordinary visible template output using escaped EJS does not protect the separate raw script serialization.

**Remediation:** use one shared serializer for data embedded in HTML that escapes `<` as a Unicode escape, along with any other required HTML/script characters. Apply it to all raw JSON template sinks containing strings, not only this example. Consider loading data through authenticated/public JSON APIs where appropriate. Do not replace raw JSON with generic HTML entity escaping that makes the JSON invalid. Test `</script>` in catalog/service strings and verify it remains data.

### S04 — Proof-file ownership gaps

Source: `server/index.js`, upload guards immediately before static delivery (approximately lines 449–474).

- `/uploads/remittance-proofs` checks authentication and a staff/technician role, but does not check that the technician owns the associated remittance.
- `/uploads/project-work-submissions` and `/uploads/project-completion-proofs` check authentication only. They do not require an assigned technician/staff role or verify the project's owner.

The local proof executes the actual middleware blocks extracted from `server/index.js`, followed by static delivery of synthetic files. An anonymous caller received 401. A different signed-in customer received another owner's project work/completion file with 200; a technician received another technician's remittance proof with 200. These tests require knowing a file URL; random filenames do not replace authorization.

Production files belonging to other users were not fetched. The deployed ownership behavior remains to be tested with controlled accounts and deliberately synthetic production fixtures.

**Remediation:** resolve each file's parent remittance/project and check ownership, assignment, role, and permission before opening the stream. Prefer storage outside the public directory and authorized download routes. Reuse the existing receipt/booking-evidence ownership patterns. Regression cases must cover owner, another customer, assigned/unassigned technician, allowed staff, and anonymous access.

Existing `receiptRoutes`, `legacyExpenseReceiptRoutes`, and booking evidence middleware already contain more specific ownership checks; the gap concerns the paths above.

### S05 — Sample secrets reused in configuration

Sources: `.env.example:91` and `.env.example:97`, `server/utils/attendanceSecurity.js`, and `server/utils/emailOutbox.js`.

The local `ATTENDANCE_QR_SECRET` and `EMAIL_OUTBOX_SECRET` exactly match the tracked example values and also match each other. Their values are deliberately omitted. Matching occurrences exist in repository history. Local JWT configuration did not match the tracked example and the scanner found no literal provider API keys in the scanned text/history.

A synthetic QR token signed using only the example-file signing value passed the real local QR verification function under the local configuration. No attendance check-in was attempted, and authentication, device, and location checks were not bypassed by this test. It specifically proves that the signing secret is publicly knowable wherever this configuration is used.

The same known value can derive the outbox encryption key. Decrypting outbox messages would additionally require access to their encrypted records; no production outbox records were accessed. Production environment equality has not been established.

**Remediation:** replace example secrets with clear placeholders/instructions. Generate distinct random secrets for QR signing and outbox encryption in each environment. Compare and rotate production values privately if they match. Do not expose new values in chat, commits, screenshots, or build logs. Removing values from the latest commit does not revoke historical copies.

Outbox rotation requires a controlled transition because existing queued payloads are encrypted with the old key. Plan draining/reissuing pending verification messages or a bounded key-version transition before changing the encryption key; do not silently discard unrelated pending business emails. QR rotation invalidates old challenges and should be followed by a fresh QR display.

### S06 — Vulnerable production dependencies

The npm audit reports **10 affected packages: 1 critical, 7 high, 2 moderate**. These are npm's dependency classifications, not ten independently demonstrated application exploits. All have reported fixes available.

| Package | Local affected version | npm severity |
|---|---|---|
| `proxy-addr` | 2.0.7 | Critical |
| `axios` | 1.18.1 | High |
| `compression` | 1.8.1 | High |
| `multer` | 2.2.0 | High |
| `nodemailer` | 9.0.3 | High |
| `engine.io` | 6.6.9 | High |
| `@grpc/grpc-js` | 1.14.4 | High |
| Nested `brace-expansion` | 2.1.4 | High |
| `ip-address` | 10.5.0 | Moderate |
| `qs` | 6.15.3 | Moderate |

Examples relevant to this system include compression leaks on prematurely closed responses, multipart upload denial-of-service issues, and Engine.IO denial of service. The `proxy-addr` critical advisory concerns IPv4-mapped IPv6 trust subnets; this application configures numeric proxy hops, so that specific exploitation condition was not demonstrated. Other advisories also have adapter/configuration or untrusted-input conditions that need individual assessment.

**Remediation:** update direct dependencies and affected transitive resolutions through a controlled lockfile change. Inspect available fixed versions and avoid blindly applying forced major upgrades. Re-run the package audit, complete suite, upload flows, streaming/chat disconnect handling, authentication behind the actual proxy, and socket checks. Compare the deployed image's resolved dependency tree with the corrected lockfile.

Selected advisory evidence: [proxy-addr](https://github.com/advisories/GHSA-jqcg-44mw-7w3h), [compression](https://github.com/advisories/GHSA-vc2v-76pw-4v95), [multer](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm). The full sanitized dependency inventory is in `temp/system-security-dependency-summary.json`.

### S07 — Client-controlled math CAPTCHA answer

Sources: `authController.js` registration, login, forgot-password, and reset-password checks; `secureAuthController.js:219`; the hidden `mathAnswer` form field.

The server compares the submitted answer with another submitted value. An automated client can choose both equal values rather than solve or honor the server-issued question. This weakens the anti-automation control; it does not bypass password checks, MFA, reset-token validation, or account permissions.

**Remediation:** bind an issued challenge to a short-lived server-side session or signed nonce and verify the submitted answer against that authoritative challenge. Consume the challenge and rate-limit issuance/submission. Do not treat the math question as a substitute for robust request limits or a genuine verified bot-control service.

### S08 — WebSocket revocation after connection

Sources: `server/index.js` socket handshake/connection handlers and `server/utils/socketTrafficProtection.js:protectPackets`.

JWT expiry, current session ID, account state, and password-change checks occur during connection. Subsequent handlers use the cached `socket.user`; packet protection checks traffic limits, not current authentication validity. No ongoing expiry/revocation check or server-side logout disconnection was found in the reviewed paths.

**Remediation:** disconnect sockets on session/account revocation, enforce token lifetime, and revalidate authorization for sensitive incoming actions and room subscriptions. Handle permission changes as well as role changes. Periodic/per-action validation must be bounded so it does not turn socket traffic into an unbounded database workload. Verify with controlled accounts that an already connected client stops receiving private events or sending sensitive actions after logout/blocking/revocation. This behavior was not exercised against production accounts.

### S09 — Webhook freshness and replay handling

Sources: `server/utils/paymongo.js:276`, `server/routes/paymongoRoutes.js`, and `paymentController.handleGatewayWebhook`.

Signature verification includes the timestamp in the HMAC but imposes no age limit. A synthetic correctly signed payload with timestamp `1` was accepted locally. Only the verifier was called; no payment event was dispatched or saved.

The handler removes an existing event ID from the stored list and appends it again rather than rejecting an already processed event. A failure event can also set an already-paid payment to failed. This warrants tests for duplicate and out-of-order events, especially if legacy gateway processing remains enabled. The online checkout endpoint is disabled with 410, which limits current customer initiation but does not remove the webhook handler.

**Remediation:** validate timestamp format and a suitable freshness window, enforce durable atomic event-ID idempotency before side effects, and preserve valid terminal payment states against stale failures. Test signed stale, duplicate, concurrent, and out-of-order events without real payment calls. Valid signature possession is a prerequisite for an attacker replay; no signature forgery or unauthenticated payment-status bypass was demonstrated.

### S10 — Detailed public AI health diagnostics

Source: `server/routes/chatRoutes.js`, `GET /health` near line 2123.

The live `/api/chat/health` response exposes provider/model configuration, number of keys, availability, previous error metadata, catalog counts, and active session counts. No actual key values or `.env` contents were detected.

**Remediation:** keep the public response to minimal liveness/readiness information. Put provider error details and configuration diagnostics behind staff authentication and permissions. Do not add arbitrary `include=env/config` behavior. Raw prompts and private customer records should not be logged.

Chat customer context is queried using the authenticated customer's ID. Model responses are not routed to database commands, operating-system commands, or filesystem reads in the reviewed customer chat implementation. However, normal external-provider prompts currently include that customer's booking references, schedules, progress, and payment totals/balances. Review whether those private fields are necessary and covered by the intended privacy policy; minimize them or keep account-status processing local. This is an external data-processing review item, not a demonstrated cross-customer disclosure.

### S11 — Browser policy headers

Live HTML responses have CSP, HSTS, nosniff, and framing protection. Permissions-Policy is absent. The CSP permits inline scripts and `unsafe-eval`; that permits the harmless execution demonstrated in S02/S03.

**Remediation:** add an explicit feature policy that retains same-origin geolocation/camera access needed by booking and technician proof flows. Review other required capabilities before disabling them. Migrate inline scripts/handlers to nonce/hash-authorized scripts or external assets, then remove unnecessary `unsafe-inline` and `unsafe-eval`. Test maps, uploads, CAPTCHA, dashboards, and chat after policy changes. A policy header alone does not fix encoding bugs.

## Interpreting the supplied screenshots

| Screenshot item | Audit interpretation |
|---|---|
| `[200] ?include=database,env,config` with `{status,database,timestamp}` | Matches a minimal health response. The supplied keys contain no environment values. A query parameter naming `env` is not proof that environment contents were returned. The direct secret-file probes returned 404. |
| Port 27017 open | Confirmed as MongoDB by this audit. Authentication denied the synthetic anonymous read, but the network exposure needs correction. |
| `/admin` and `/login` found | Path discovery is expected. Live `/admin` redirected, and tested admin/user/inventory APIs returned 401 without login. These observations do not prove an admin bypass. |
| `XSRF-TOKEN` lacks HttpOnly | A JavaScript-readable CSRF cookie is a common double-submit design. The live token has Secure and SameSite Strict. The actual `auth_token` and `sid` are configured HttpOnly in source; authenticated production cookies were not inspected because no login was performed. |
| Missing Permissions-Policy | Confirmed low-priority browser hardening item. |
| “Defacement marker present” | Unverified. The live `/js/navbar-active.js` contains an ordinary “is owned by” source comment and no detected “hacked by”, “defaced by”, or “pwned” phrase. This is a plausible broad-regex false positive. The screenshot truncates the exact finding URL, so this audit cannot assert that it explains every defacement hit. Obtain the exact matched response and marker before calling it a confirmed compromise. |

## Controls that held in this review

- Direct and encoded `.env` paths, production/internal env names, `.git/HEAD`, and `/package.json` returned 404 without detected credential contents.
- Anonymous admin/user/inventory API access returned 401; `/admin` redirected to sign-in.
- Public technician responses contained booking-facing IDs, names, and ratings, with no detected email/phone/address or password fields in the inspected response shape. Public scheduling responses returned availability rather than customer contact data in the inspected endpoints.
- Current JWT verification restricts algorithms to HS256; login cookies are HttpOnly in source. Server checks include enabled accounts, password-change invalidation, and current-session binding on the reviewed JWT paths.
- The recent OTP changes use a browser-bound challenge, CSRF checks, persistent attempt limits, cooldowns, and one-time consumption. The prior complete test run and this audit's relevant focused tests passed.
- Customer APIs and model context commonly use server-resolved user IDs and owner filters. Explicit protected receipt/booking evidence routes perform more specific ownership checks.
- Requests have body-size limits, admission/concurrency controls, auth/general/chat rate limits, bounded chat history/session counts, and provider timeouts/fallback behavior. These reduce abuse but do not compensate for vulnerable parser/compression/socket dependencies.
- Reviewed image helpers restrict supported types and provide signature checks; not every upload path uses the same validation uniformly. Expand upload regression coverage during remediation.

## Remediation order and release checks

1. **Server operator:** identify and close/restrict the actual port-27017 listener. Confirm the application still uses its authenticated private connection. Preserve data/volume; take a fresh backup before infrastructure changes and validate restoration in an isolated environment.
2. **Application:** fix both chatbot link construction and raw HTML/script JSON serialization, then add browser regressions for executable markers and malformed links.
3. **Application:** enforce parent-record ownership/assignment on every private proof-file download and move private assets behind authorized streaming routes.
4. **Configuration owner:** replace the sample secrets where used, with a safe outbox key transition. Check current production values privately; do not assume the local environment proves the deployed value.
5. **Dependencies:** update affected packages/resolutions and verify the deployed image matches the corrected lockfile.
6. **Remaining controls:** server-bound CAPTCHA, live socket revocation, webhook freshness/idempotency, minimal public diagnostics, and browser policy hardening.
7. **Release:** run the complete suite and focused browser/security checks, deploy a consistent release to all instances, then repeat the live port, file, header, unauthorized API, controlled cross-user download, logout/socket, and webhook checks.

Infrastructure access, Dokploy environment values, firewall/service ownership, SSH hardening, image contents/build-secret handling, server patches, MongoDB user privileges/version, and current offsite backup/restore status remain operator checks. The owner previously reported an empty native MongoDB Backup list; a database volume is not a verified backup. See `docs/backup-audit-2026-10-14.md` and `docs/dokploy-backup-storage-setup.md` for that separate audit and storage setup.

## Reproduction artifacts

All contain synthetic payloads or sanitized metadata, not production secrets/records:

- `temp/system-security-audit.cjs` and `temp/system-security-static.json`: route/history/secret metadata scan.
- `temp/system-security-live.cjs` and `temp/system-security-live-results.json`: limited HTTP/header/handshake results.
- `temp/mongo-authorization-audit.cjs` and its result JSON: anonymous authorization denial on a synthetic namespace.
- `temp/security-local-proofs.cjs` and `temp/security-local-proof-results.json`: actual formatter/catalog serialization, actual upload middleware, synthetic QR and stale webhook proofs.
- `temp/system-security-dependency-summary.json`: local affected versions and advisory references.
- `temp/system-security-regression-check.log`, `temp/system-security-access-check.log`, `temp/system-security-privacy-traffic-check.log`: 136 passing focused tests.

These fixtures are local audit tools, not production endpoints or a permanent automated security test suite. Passing this limited review is not certification that every deployment component or application action is secure. The unresolved findings above require remediation and retesting.
