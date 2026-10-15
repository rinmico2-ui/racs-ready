# Connect localhost to the existing Dokploy database privately

## Current status

The workstation's ignored `.env` still points to `45.85.146.21:12131`.
The reported `ECONNREFUSED` prevents the application from starting. No MongoDB
server is listening locally on ports 27017 or 27018. The developer needs the
existing deployed records, rather than a new empty database.

No connection settings, firewall rules, SSH accounts or production records were
changed during this investigation. A working private connection is still needed.
Keep the public MongoDB port closed.

The application container terminal does not provide the VPS owner's SSH account.
Use the VPS provider's console or an authorized server terminal. Dokploy documents
**server dropdown -> Enter Terminal** for configured remote servers in its
[server instructions](https://docs.dokploy.com/docs/core/remote-servers/instructions).
If that control is unavailable, the VPS owner must provide the access below.

## Workstation: create a dedicated SSH key

Run these in your own Windows PowerShell terminal. They write to your private
Windows profile, outside the project. If the key already exists, retain it;
do not overwrite it. Choose a passphrase when prompted.

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.ssh" | Out-Null
ssh-keygen -t ed25519 -a 64 -f "$env:USERPROFILE\.ssh\racs-dokploy-dev"
Get-Content -LiteralPath "$env:USERPROFILE\.ssh\racs-dokploy-dev.pub"
```

Send only the `.pub` public key to the VPS owner. Keep the private key and its
passphrase on your computer. No database password belongs in an SSH command.

## VPS owner: provide a restricted forwarding destination

1. Provide an SSH account that accepts this public key. Restrict it to local
   TCP forwarding to the MongoDB destination, with no interactive shell,
   commands, remote forwarding, agent forwarding, X11 forwarding or PTY.
   OpenSSH supports an account-specific `Match User` section with
   `AllowTcpForwarding local` and `PermitOpen HOST:PORT`, and a forced command
   such as `/bin/false`. Validate the SSH configuration before reloading it;
   retain the existing administrative session while testing.
2. Determine a private MongoDB address reachable **from the SSH server**.
   `templates-emak-q9jqps:27017` is the application's Docker-network destination;
   it must not be assumed to resolve from the host or the Windows computer.
   Verify routing from the host before selecting an address. If a loopback proxy
   is necessary, bind it explicitly to the VPS's `127.0.0.1` and connect its
   upstream to the private Docker network. Do not publish a database or proxy
   on `0.0.0.0`, `::`, or the VPS's public IP.
3. Give the developer the SSH username, SSH port, forwarding destination and
   server host-key fingerprint over a trusted channel. This information does
   not require sharing the owner's password or private SSH key.

These values depend on the server's actual network and SSH configuration. The
application container's hostname or ID alone is not a verified tunnel target.
The owner must maintain a stable destination across container redeployments.

[OpenSSH server restrictions](https://man.openbsd.org/sshd_config)
and [public-key restrictions](https://man.openbsd.org/sshd.8) describe these controls.

## Workstation: open and verify the tunnel

Replace `SSH_USER`, `SSH_PORT`, `PRIVATE_MONGO_HOST` and `PRIVATE_MONGO_PORT`
with the owner's verified values. Run this in Windows PowerShell and keep it
open. On the first connection, compare the displayed host-key fingerprint with
the one provided by the owner before accepting it.

```powershell
ssh -N -T -i "$env:USERPROFILE\.ssh\racs-dokploy-dev" -p SSH_PORT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:27018:PRIVATE_MONGO_HOST:PRIVATE_MONGO_PORT SSH_USER@45.85.146.21
```

The listener is confined to this workstation's loopback interface. Do not add
`-g` or disable host-key verification. A running SSH process or an open local
port does not by itself establish that MongoDB authentication succeeds.

After the tunnel is established, update only the workstation's ignored `.env`:
preserve the existing authenticated MongoDB URI's username, encoded password,
database name, `authSource`, replica-set name and other required options; change
its address to `127.0.0.1:27018` and use `directConnection=true` so discovery does
not redirect the Windows client to Docker-only hostnames. Preserve TLS and
certificate verification if the database requires them. Keep Dokploy's
production environment using its existing private connection.

From the application root, verify the connection without starting the app:

```powershell
node server/scripts/diagnoseMongoConnection.js --require-transactions
```

Require a successful authenticated ping and transaction-capable replica-set
metadata. This diagnostic performs no business-record writes. It does not
replace a real workflow check or prove every application permission.

## Before starting a second application against live records

The current application starts email-outbox, overdue-booking, maintenance,
equipment-return, daily-kit, attendance, delay and assignment-expiry workers,
and an hourly technician-status reset. A developer instance must not start an
additional set of those jobs against production. A development-only startup
mode that suppresses these jobs still needs to be configured and verified
before running `npm run dev` against the tunnel. Keep the production workers
running normally.

Even after background jobs are disabled, normal login, session, email and form
actions can write to the live database. An SSH tunnel protects transport; it
does not make the application read-only. For changes that need independent test
data, use a separate development database or a private, sanitized copy instead.
