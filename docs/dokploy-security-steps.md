# Dokploy security steps — 15 October 2026

The application changes are in this workspace. They are not deployed to `racsready.its-au.space`. No production firewall, database, DNS, user account, email or payment was changed during testing.

The earlier audit confirmed a MongoDB listener on public port **27017**. Its authentication rejected a synthetic unauthenticated read. The `.env` probes returned 404; the screenshot's health JSON did not contain environment variables or database records. Public database exposure still needs fixing. An empty External Port field on `emak` does not identify the process responsible for this listener.

## 1. Contain the flood before deploying

1. Log in to the server provider's dashboard. Open its **Firewall / Security Group** settings for the Dokploy server.
2. Remove public inbound access to **TCP 27017 and 12131** for **both IPv4 and IPv6**. If the provider has an allow-list firewall, do not add these ports. Keep internal/private traffic working.
3. Preserve public **TCP 80 and 443** for the site. Preserve SSH access on its actual port, preferably from your current administrator IP. Keep the provider's recovery console available before changing administrator access.
4. If this is a multi-node Docker Swarm, preserve node-to-node ports only between the cluster's private node addresses. Do not apply a blanket firewall reset.
5. If signup abuse is still active, temporarily turn off **Allow customer registrations** in the application's admin application settings. Restore it after the fixed deployment passes verification.

A provider firewall blocks traffic before Docker's published-port forwarding. `ufw deny 27017` by itself is not enough evidence that a Docker-published database is private. See [Docker firewall documentation](https://docs.docker.com/engine/network/firewall-iptables/).

## 2. Identify what is publishing MongoDB

In Dokploy, select the server and open **Terminal**. Run these read-only commands one at a time:

```sh
sudo ss -lntp '( sport = :27017 or sport = :12131 )'
```

```sh
docker service ls --format 'table {{.Name}}\t{{.Ports}}'
```

```sh
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

```sh
docker service inspect templates-emak-q9jqps --format '{{json .Endpoint.Spec.Ports}}'
```

These commands show ports and service names, not database passwords. Do not paste a full `docker inspect`, Environment tab, connection URI, or database record into chat.

Read the results:

- A service publishing `*:27017->27017/tcp` owns the public Swarm port. Its name may differ from `templates-emak-q9jqps`.
- A container showing `0.0.0.0:27017->27017/tcp` or `[::]:27017->27017/tcp` owns a directly published Docker port.
- A `mongod` listener with no Docker publication may be a MongoDB process installed on the host. Do not stop it before identifying which application uses it.
- Empty `ss` output alone is not sufficient: Swarm can publish a port through packet forwarding without a userspace listener.

## 3. Confirm the application uses the internal database

1. Open MongoDB **emak → General → Internal Credentials**. Confirm its internal host is `templates-emak-q9jqps`, port `27017`, and check the actual database name and authentication database.
2. Open the **application service → Environment**. Edit `MONGODB_URI` privately to use that internal host and authenticated credentials. Preserve the existing database name, `authSource`, and necessary connection options. Copy Dokploy's internal connection details; do not create a new database or substitute a public IP.
3. Confirm the application and MongoDB are connected to the same Dokploy internal network. Native application/database services normally use Dokploy's network; a custom Compose app may need explicit network attachment.
4. Redeploy the application and check `/ready` returns `200`, then open a known existing booking. If the application's data disappears, revert the URI and investigate the database name; do not seed or replace production data.
5. Obtain a fresh backup before changing an unrecognized MongoDB service or its credentials. The earlier local archive is not a verified current offsite backup. The destination instructions are in [the backup setup guide](dokploy-backup-storage-setup.md).

## 4. Remove the publication at its source

Choose the case identified in step 2:

**Native Dokploy database:** Open the owning database service's External Credentials / External Port field. Clear the external port and Save. Keep its internal port as `27017`.

**Compose:** Edit the owning service's Compose configuration. Remove the MongoDB `ports:` mapping that publishes 27017. Keep its existing volume and internal network. `expose: ["27017"]` is optional; containers on the same network can already communicate. Redeploy that Compose service. Do not remove volumes.

**Swarm publication remains after the saved Dokploy configuration is corrected:** Inspect the actual owning service:

```sh
docker service inspect ACTUAL_MONGO_SERVICE --format '{{json .Endpoint.Spec.Ports}}'
```

Replace `ACTUAL_MONGO_SERVICE` with the exact service name from step 2. If the result explicitly lists `PublishedPort:27017`, remove only that publication:

```sh
docker service update --publish-rm 27017 ACTUAL_MONGO_SERVICE
```

This can roll the MongoDB task and briefly interrupt access. Apply it after backup/internal connectivity checks. Correct the saved Dokploy or Compose definition as well, or a redeploy can restore the publication. Do not remove the service or volume.

**Host-installed MongoDB:** Ask the server administrator to identify its consumers and configure `net.bindIp` for the required private/loopback interface, retaining authentication. Changing it to loopback can break Docker clients. The provider firewall from step 1 contains the exposure while this is investigated.

## 5. Set secrets and limits before deploying the updated application

Production startup now refuses missing, short, reused or known sample secrets. In the application Environment tab, generate three independent random values, at least 32 characters each, for `JWT_SECRET`, `EMAIL_OUTBOX_SECRET`, and `ATTENDANCE_QR_SECRET`. Keep the same values across all replicas.

You can generate each new value privately inside a trusted terminal using:

```sh
openssl rand -hex 48
```

Run it separately for each secret. Copy the outputs into Dokploy; do not send them in chat or commit them. **Changing `JWT_SECRET` signs users out. Changing the QR secret invalidates old attendance QR codes.** Keep an existing strong JWT secret if it was not compromised.

Before changing the outbox secret, preserve the current `EMAIL_OUTBOX_SECRET` as `EMAIL_OUTBOX_PREVIOUS_SECRET` (or the current JWT secret if the outbox previously fell back to JWT). Set `EMAIL_OUTBOX_PREVIOUS_SECRET_UNTIL` to an ISO timestamp **24 hours ahead**. This lets existing queued emails decrypt while new emails use the new key. Check the Email settings/outbox for remaining old jobs, then remove both previous-key variables after the queue drains. The application refuses an expired or longer-than-seven-day grace period at startup. Do not rotate the outbox key without preserving the old reader or handling pending emails first.

Set these numeric application variables:

```dotenv
SIGNUP_IP_MINUTE_LIMIT=5
SIGNUP_IP_WINDOW_LIMIT=20
AUTH_EMAIL_IP_MINUTE_LIMIT=5
AUTH_EMAIL_IP_WINDOW_LIMIT=20
AUTH_MAX_CONCURRENT_REQUESTS=8
AUTH_MAX_CONCURRENT_PER_IP=4
HTTP_MAX_CONCURRENT_REQUESTS=64
HTTP_MAX_CONCURRENT_PER_IP=24
HTTP_PER_IP_RATE_LIMIT=600
REGISTER_IP_RATE_LIMIT=20
```

The signup/email limits count attempts, including accepted pending registrations, across application replicas. A shared network with more than twenty legitimate new signups needs a planned temporary adjustment. Successful logins keep their separate allowances. Do not simply increase every limit to remove a 429.

Rebuild the updated code and lockfile. Deploying only environment variables will not install the fixes. After deploying, open the application's container terminal and run `npm run security:preflight`; it prints checks and variable names, not values.

## 6. Add protection in Dokploy's reverse proxy

1. Open the **application → Advanced → Traefik File System**. Save a private copy of the current configuration for rollback. Use the application-specific file, not a replacement global Traefik configuration.
2. Merge the `http.middlewares` entries from [the supplied configuration](../deploy/traefik/security-middlewares.yml) into the existing `http.middlewares`. Preserve all existing `routers`, `services`, TLS certificates and redirect middleware.
3. Append `racs-site-traffic`, `racs-site-capacity`, and `racs-response-headers` to the existing HTTPS router's `middlewares` list.
4. To protect signup more tightly, copy the existing HTTPS router to a new unique name, preserving its entry points, service, TLS and existing middlewares. Give the copied router priority `200` and this rule:

```yaml
rule: "Host(`racsready.its-au.space`) && Method(`POST`) && PathRegexp(`(?i)^/api/auth/(register|google/complete-signup)/?$`)"
priority: 200
```

5. Append `racs-signup-traffic` to that copied router's middleware list, alongside the site middleware. Do **not** attach the signup middleware to the whole site.
6. Save, check Traefik logs for configuration errors, then verify the homepage, login, signup, address selection and Socket.IO connection. Roll back the configuration copy if the service route becomes unavailable.

The supplied default per-source rules use Traefik's direct peer IP. This is correct with just Traefik in front of the app. If Cloudflare is in front, first complete step 7 and configure **Traefik's forwardedHeaders.trustedIPs** for Cloudflare's official IPv4/IPv6 ranges. Never use `forwardedHeaders.insecure=true`. Once origin access is restricted and the forwarded header chain verified, add `sourceCriterion.ipStrategy.depth: 1` to each per-client Traefik rate limiter. Keep `requestHost: true` on the aggregate limiter. For the usual verified `client → Cloudflare → Traefik → app` chain, use `TRUST_PROXY_HOPS=2`; with only `client → Traefik → app`, use `1`. Do not raise hops while direct origin access is still permitted. Check an admin activity log shows the actual visitor IP, not a shared proxy address.

See [Dokploy's hardening guide](https://docs.dokploy.com/docs/core/guides/production-hardening) and [Traefik's rate-limit documentation](https://doc.traefik.io/traefik/v3.5/reference/routing-configuration/http/middlewares/ratelimit/).

## 7. Add a free edge layer for DDoS protection

1. Use Cloudflare's **Free** plan if you control the DNS zone. If your school/provider owns `its-au.space`, ask that owner to proxy `racsready.its-au.space`; adding just this subdomain as your own free zone may not be available.
2. In Cloudflare **DNS**, enable the orange-cloud **Proxied** setting on the site's A/AAAA or CNAME record. Do not publish a database DNS record. Wait for DNS changes to apply.
3. In **SSL/TLS**, select **Full (strict)** and keep a valid origin certificate in Dokploy. Do not use Flexible.
4. Verify the site, mobile checkout, geolocation, login and live tracking. Preserve **WebSockets** support. Do not cache `/api/*`, authentication pages or private staff/customer pages.
5. Restrict public origin **80/443** at the provider firewall to [Cloudflare's current IPv4 and IPv6 ranges](https://www.cloudflare.com/ips/). Preserve separate SSH/admin recovery access. This applies to every website on that server using these ports; coordinate other hosted sites before changing the shared firewall. An unproxied Dokploy hostname also needs an administrator access rule or its own proxy.
6. Keep Cloudflare's HTTP DDoS protection enabled. It is available on Free and enabled automatically for onboarded zones. See [the official setup guide](https://developers.cloudflare.com/ddos-protection/get-started/).
7. During an active HTTP flood, use **Under Attack mode** temporarily, preferably scoped to public HTML pages through a configuration rule. It can interrupt APIs, payment webhooks and application requests; test those flows and turn it off after the incident. [Cloudflare documents this limitation](https://developers.cloudflare.com/waf/tools/security-level/).

Application limits and Traefik protect application resources. A flood that saturates the server's internet connection requires protection at Cloudflare and/or the hosting provider. Cloudflare will not protect a still-public MongoDB port or a bypassable origin address.

## 8. Verify without flooding production

1. From your own Windows computer, outside the server network, run:

```powershell
Test-NetConnection racsready.its-au.space -Port 27017
Test-NetConnection racsready.its-au.space -Port 12131
```

Both should show `TcpTestSucceeded: False`. After Cloudflare is enabled, repeat these checks against the **origin server IP from your provider dashboard**; testing only the proxied hostname does not verify the origin is closed. Keep that IP private.

2. Confirm `/ready` returns 200 and existing customer data remains visible to its owner.
3. Check `/.env`, `/.git/HEAD` and `/server/.env` return 404. Do not put credentials into the URL to test them.
4. Check `/api/chat/health` returns only `{"status":"ok"}`. General chatbot questions should still work; account-specific responses stay local.
5. Open a legitimate account signup/login and complete its new challenge. Confirm OTP acceptance is shown as queued/accepted rather than guaranteed inbox delivery. Use your email provider's delivery history to investigate missing mail.
6. Check cross-account proof files return 403/404 and an owning customer or technician can still open their file.
7. Confirm response headers contain Permissions-Policy and the CSP no longer permits `unsafe-eval`. Keep the JavaScript-readable XSRF cookie; session/auth cookies must remain HttpOnly.
8. Check the activity log and provider monitoring for rejected traffic and resource recovery. Local regression tests already replay the signup flood against synthetic fixtures; another production flood is unnecessary.

Backups, public-port closure, DNS/proxy settings and deployed image checks remain operator tasks until you apply and verify them. Keep pentest retests scoped and scheduled so legitimate customers are not disrupted.
