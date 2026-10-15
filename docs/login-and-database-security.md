# Login OTP and database security review

Reviewed October 14–15, 2026. Changes are in the workspace; production deployment and Dokploy infrastructure changes have not been performed.

**Later audit update:** the screenshots identified a different public port, **27017**. The October 15 [system audit](security-audit-2026-10-15.md) confirmed MongoDB on that port and confirmed that an anonymous synthetic read was denied with authorization error 13. The earlier refusal concerned port **12131**. Use the newer audit for current database exposure findings and the additional application security issues.

## What the deployed checks established

- The live site's `/.env` and `/.git/config` returned 404, with no detected credential content. `/api/admin/settings/email-status` returned 401 without a login.
- An initial TCP connection to the database endpoint configured locally opened. Subsequent unauthenticated MongoDB `hello` checks could not complete and the latest check reported connection refusal. **Public MongoDB access or unauthenticated access to records is not confirmed.** No records, database lists, or authenticated database commands were requested.
- The owner reports that the native MongoDB service's External Port field is empty. Keep it empty. A TCP connection alone cannot establish which service, if any, is responding; do not assume that this service exposes MongoDB.
- Brevo's read-only events for October 14 contained recipient-server delivery events for all five login message IDs in the supplied logs. One also had an opened event. This confirms delivery to the recipient mail server, not placement in the Inbox or that a person read it. No real test emails were sent.
- The configured sender uses a public Gmail address. This can affect deliverability because the application owner cannot authenticate Gmail's domain. It is a configuration concern, not proof that these five messages failed.
- Gemini 503/timeouts, project access denial, and Groq 429 are AI provider failures. They do not demonstrate database exposure. The supplied logs show the existing local fallback being used.

## Application changes

- Password verification remains mandatory before creating a login OTP. Staff MFA and trusted technician behavior remain enabled.
- Pending MFA now requires a random HttpOnly, SameSite Strict browser cookie. Resend and verification also require the sign-in form's CSRF token and validated string inputs.
- MongoDB atomically enforces the 60-second email cooldown, five failed-code attempts per challenge, and one-time consumption across web instances. Resending preserves the original ten-minute deadline and failed-attempt count. A password change invalidates the pending challenge.
- Login generation returns delivery metadata instead of a plaintext OTP. Public responses distinguish queued email from provider acceptance. Resend errors appear beside the field; 400, 429, 503, and HTML gateway responses cannot produce a false success notification. Editing sign-in credentials resets the OTP step and ignores stale responses.
- The email worker discards expired, replaced, consumed, or legacy unbound login codes. Completed and permanently failed jobs erase their encrypted payload. Accepted jobs retain the provider message ID for tracing.
- Admin Settings → Email adds **Check delivery** for accepted Brevo messages. This fetches delivery event metadata, never message bodies or OTPs. Public-domain senders receive a configuration warning. Normal mail console messages mask recipient addresses.
- Config, repository, dependency, and database dump paths are explicitly rejected before database middleware. Production MongoDB URIs require credentials; TLS validation cannot be silently disabled for public connections. The existing explicitly opted-in private Docker network exception remains available.
- Automatic admin bootstrap requires explicit credentials and a password of at least 14 characters. It no longer uses a published default password, promotes an existing non-admin account, or resets that account's password. Existing admins remain usable.

## Dokploy deployment and verification

1. In the **application** service's Environment tab, use the MongoDB service's **Internal Connection URL**. Keep the existing database name, username, password, and authentication database. Check that the private host matches the actual service (previously `templates-emak-q9jqps`) and the internal container port is `27017`. Do not paste credentials into chat.
2. Set `NODE_ENV=production`. If the native MongoDB service uses a private Docker network without TLS, use its single-label internal hostname and set `MONGODB_ALLOW_PLAINTEXT_INTERNAL=true`. Public MongoDB endpoints must use validated TLS. Do not point a private-network exemption at a public address.
3. Keep MongoDB's **External Port (Internet)** empty. Verify the application is healthy using its internal connection before changing any existing published access. Do not delete or recreate the database service or its volume.
4. When the UI shows no external port but an evaluator reports public access, an operator can inspect actual port mappings in the Dokploy server terminal using these **read-only** commands:

   ```sh
   docker service ls --format '{{.Name}}\t{{.Ports}}'
   docker service inspect templates-emak-q9jqps --format '{{json .Endpoint.Spec.Ports}}'
   docker ps --format 'table {{.Names}}\t{{.Ports}}'
   ```

   Substitute the exact running service name if different. These commands print service names and ports only. Any MongoDB published port must be removed from its owning service's Dokploy configuration, or restricted through a properly configured private management network. Confirm MongoDB authorization is enabled and use a dedicated application database user with only the required database permissions. Recheck from outside the server after applying the configuration. An empty field alone does not audit older services or running port mappings.
5. Redeploy the updated application. In-flight codes from the previous login implementation cannot finish the new browser-bound flow; users should restart sign-in. MongoDB schema fields and email-job status additions need no destructive migration. Ensure all running instances use the same updated release and signing/encryption secrets.
   Any account previously created with the old bootstrap default retains its current password; this change does not reset existing accounts. An operator should replace a known default password through the authenticated account controls.
6. Keep `BREVO_API_KEY` configured on the application. Open Admin Settings → Email and use **Check delivery** on the relevant login message. Check the recipient's Spam and All Mail folders. For rejected or blocked events, inspect Brevo transactional logs by provider message ID and resolve the reported reason. If delivered email still cannot be found, supply that message ID and timestamp to Brevo support.
7. Have the domain owner authenticate a domain/subdomain in Brevo using its required DNS records, then configure `FROM_EMAIL` to a sender on that authenticated domain. Sender configuration and DNS changes were not performed from this workspace.

Dokploy recommends internal credentials for applications in the same network: [database connection documentation](https://docs.dokploy.com/docs/core/databases/connection). Brevo documents [transactional delivery events](https://developers.brevo.com/reference/get-email-event-report) and [sender domain setup](https://help.brevo.com/hc/en-us/articles/35852083084178-Domain-setup-for-better-email-deliverability).

## Validation

31 new regression tests cover browser binding, CSRF, incorrect passwords, concurrent email requests, persistent guess limits, one-time verification, password changes, disabled accounts, expiry, stale queued codes, encrypted payload cleanup, provider event handling, deployment guards, and sensitive paths. The focused security, email, and trusted-device run passed 49 tests. Browser checks use mocked APIs at 1440px and 390px; they send no email and access no live database. The full suite passed 2,056 tests with zero failures.

To close the database pentest finding, obtain its exact redacted host/port or affected URL and demonstrated result, compare it with the running service mappings, and repeat the evaluator's read-only verification after deployment. The available checks are not a full penetration test or a verified backup/restore exercise.
