# Enable transactions on the existing Dokploy MongoDB service

The service details supplied during troubleshooting are:

| Setting | Value |
| --- | --- |
| Internal hostname | `templates-emak-q9jqps` |
| Internal port | `27017` |
| Existing volume | `templates-emak-q9jqps-data` |
| Existing volume mount | `/data/db` |
| Database reported by the diagnostic | `test` |

These steps use the official `mongo` image, its `mongodb` operating-system user,
and its normal Docker entrypoint. Confirm the Docker image in General/Advanced
before applying them. If the service uses another image or a custom entrypoint,
check its user and startup behavior first. The preparation command also checks
for the expected user, tools and existing database files.

This creates a single-member replica set so the existing server can run
transactions. It does not add a second copy of the database or server failover.
Do not increase Swarm's replica count with the same database volume.

## 1. Pause the application and back up

Confirm the deployed application's current
database name; the diagnostic shared in chat was run from local PowerShell and
reported `test`. Keep the actual deployed database name throughout this change.

Pause the RACS application and any other workers using this database while
making the backup and changing the MongoDB startup settings. Keep the MongoDB
service running for the backup and preparation steps. Its restart will briefly
interrupt database access.

Back up the existing database and verify that the backup is stored outside the
container and this data volume. If Dokploy's backup Destination list is empty,
add an existing S3-compatible storage bucket under **Settings -> S3 Destinations**
(`/dashboard/settings/destinations`). Supply its bucket, access key, secret key,
region and endpoint; test the connection, then select it on the database backup
form. The optional backup path/prefix does not create a destination.

If no Settings menu is visible, open the destination page directly:
[S3 Destinations on this Dokploy server](https://dokploy.its-au.space/dashboard/settings/destinations).
The Overview Backups tab lists backup jobs; it does not replace the destination
configuration page. If the destination page redirects or its Create control is
missing, check the account's access with the Dokploy owner/administrator. The
upstream destination page restricts member access and its Create control depends
on the `destination.create` permission.

For a one-time backup without a storage bucket, use MongoDB Database Tools on
your Windows computer. Download the Windows ZIP from the
[official download page](https://www.mongodb.com/try/download/database-tools),
extract it, and open PowerShell in its `bin` folder. Use the currently published
database endpoint while it is still available. These commands save the archive
outside the Git repository, with a unique filename, and prompt for the database
password instead of placing it in command history:

```powershell
$racsBackupFile = Join-Path $env:USERPROFILE ("Downloads\racs-mongodb-{0}.archive.gz" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
.\mongodump.exe --host 45.85.146.21 --port 12131 --username emak --authenticationDatabase admin --archive="$racsBackupFile" --gzip
if ($LASTEXITCODE -ne 0) { throw 'Backup failed. Keep the database startup settings unchanged.' }
Get-Item -LiteralPath $racsBackupFile | Select-Object Name, Length, FullName
```

This dumps all accessible databases on this standalone server, including the
database named `test`; it does not rename or modify them. Keep the archive private
because it contains application data. Check the dump's completion messages and
collection counts, then perform a read-only archive check with the same tools:

```powershell
.\mongorestore.exe --host 45.85.146.21 --port 12131 --username emak --authenticationDatabase admin --archive="$racsBackupFile" --gzip --dryRun --verbose
if ($LASTEXITCODE -ne 0) { throw 'Backup check failed. Do not change the database setup yet.' }
```

`--dryRun` does not restore or change database records. It checks the restore plan;
it is not a substitute for a complete restore test on a separate temporary server.
If a tool is missing, authentication fails, or the archive check fails, resolve
that before restarting MongoDB with new arguments.

Keep the existing image version, database username/password and `/data/db` mount.
Use Redeploy for startup changes. **Rebuild Database deletes the saved data.**

## 2. Prepare the keyfile before changing startup arguments

Open the **MongoDB service's container terminal**, using its root shell. This is
the terminal where `mongod` and `mongosh` are available, rather than the RACS
application terminal or local PowerShell.

Run this whole block. It creates one private keyfile inside the existing volume
and prints only the file's owner, permissions and path. It does not print the
key or alter booking/payment records. It refuses to overwrite an existing file.

```sh
(
  set -eu
  if [ "$(id -u)" -ne 0 ]; then
    echo "Open the MongoDB container terminal as root before continuing."
    exit 1
  fi
  id mongodb >/dev/null
  command -v openssl >/dev/null
  command -v mongosh >/dev/null
  test -f /data/db/WiredTiger
  task_key_path=/data/db/.racs-replica-keyfile
  test ! -L "$task_key_path"
  if [ ! -e "$task_key_path" ]; then
    (umask 077; set -C; openssl rand -base64 756 > "$task_key_path")
  fi
  test -f "$task_key_path"
  test -s "$task_key_path"
  chown mongodb:mongodb "$task_key_path"
  chmod 400 "$task_key_path"
  stat -c '%U %a %n' "$task_key_path"
)
```

The last line should show:

```text
mongodb 400 /data/db/.racs-replica-keyfile
```

If any command fails, keep the current MongoDB startup settings and share the
error. Do not redeploy with a missing or unreadable keyfile. Never paste its
contents or upload it here.

## 3. Add the MongoDB arguments and redeploy

In **MongoDB service -> Advanced -> Add Argument**, add four separate entries in
this order:

| Entry | Value |
| --- | --- |
| 1 | `--replSet` |
| 2 | `rs0` |
| 3 | `--keyFile` |
| 4 | `/data/db/.racs-replica-keyfile` |

Keep the default Docker entrypoint and existing password settings. Leave the
service attached to `dokploy-network`. Save and **Redeploy the MongoDB service**.
Check its logs for startup errors before proceeding.

This uses custom arguments with the normal MongoDB entrypoint, rather than
Dokploy's separate built-in `replicaSets` startup script. In the implementation
inspected, that script overrides custom arguments and starts without keyfile
authentication. The `--keyFile` argument in this procedure enforces user
authentication as well as authentication between replica set members.

## 4. Initialize the replica set once

Reopen the MongoDB container terminal after redeployment. Check the service name
resolves inside its network:

```sh
getent hosts templates-emak-q9jqps
```

Connect locally with the existing database administrator account. The password
is requested interactively; do not put it in a command or share it here.

```sh
mongosh 'mongodb://localhost:27017/admin?directConnection=true' --username emak --password
```

Inside **mongosh**, run:

```js
rs.initiate({
  _id: "rs0",
  members: [{ _id: 0, host: "templates-emak-q9jqps:27017" }]
})
```

Expect `ok: 1`. Allow a few seconds for the server to become primary, then run:

```js
db.hello()
```

Look for `setName: "rs0"` and `isWritablePrimary: true`. If the set is already
initialized, inspect `rs.conf()` and `rs.status()` instead of forcing a new
configuration. Do not create a replacement administrator or reset the database.

## 5. Update the deployed application's connection

In **RACS application -> Environment**, use the internal hostname. For the
database `test`, the values are:

```dotenv
MONGODB_URI=mongodb://emak:URL_ENCODED_PASSWORD@templates-emak-q9jqps:27017/test?authSource=admin&replicaSet=rs0
MONGODB_ALLOW_PLAINTEXT_INTERNAL=true
```

Replace `URL_ENCODED_PASSWORD` privately with the existing URL-encoded password.
Use the actual deployed database name if it differs from `test`. The plaintext
opt-in above is specifically for the private Docker network; it must not be used
as a substitute for TLS on a public connection.

Remove obsolete `MONGODB_DIRECT_HOSTS` and `MONGODB_REPLICA_SET` overrides from the
application environment when using this single internal URI; its replica set
name is already included. Both services must share `dokploy-network`.

Save and redeploy/start the RACS application. Updating the local `.env` alone does
not update Dokploy. Local development cannot normally resolve this Docker-only
hostname; do not copy the internal URI into local configuration unless the
developer machine has a separate way to reach that private network.

After checking that the application connects internally, remove the public
MongoDB port mapping if nothing else needs it. Keep authentication enabled.

## 6. Check transactions before retrying payment review

In the **RACS application container terminal**, run:

```sh
cd /app
node server/scripts/diagnoseMongoConnection.js --require-transactions
```

Expect the existing database name, `topology=replica_set`,
`writable primary=true`, `transactions configured=true` and replica set `rs0`.

Then review one intended order payment in the Resolution Center and check that
both the order and its payment record reflect the result. A verified downpayment
can show `partial` while the remaining balance is still due. Do not retry a whole
batch without reviewing their current states first.

## Sources

- [Convert an existing standalone MongoDB server](https://www.mongodb.com/docs/manual/tutorial/convert-standalone-to-replica-set/)
- [MongoDB keyfile ownership, permissions and authentication](https://www.mongodb.com/docs/manual/tutorial/deploy-replica-set-with-keyfile-access-control/)
- [Dokploy MongoDB arguments and startup behavior](https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/databases/mongo.ts)
- [Official MongoDB Docker entrypoint](https://github.com/docker-library/mongo/blob/master/docker-entrypoint.sh)
- [Dokploy backup destinations](https://docs.dokploy.com/docs/core/databases/backups)
- [MongoDB archive backups and password prompts](https://www.mongodb.com/docs/database-tools/mongodump/)
- [MongoDB restore dry run](https://www.mongodb.com/docs/database-tools/mongorestore/)
