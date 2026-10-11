# MongoDB transactions on Dokploy

## Why actions fail

`Transaction numbers are only allowed on a replica set member or mongos`
means the MongoDB server is running as a standalone server. It can serve lists
and ordinary saves, but it cannot perform multi-document transactions.

The application uses transactions to keep related records together. For example,
`PATCH /api/orders/:id/payment` verifies the payment record and changes the order
status in the same transaction. Booking schedules, cancellations, refunds,
maintenance and equipment returns also have transaction-dependent paths.

Some creation paths have explicit standalone cleanup support. That does not make
every workflow compatible with a standalone server.

Changing `directConnection` or adding `retryWrites=false` does not enable
transactions. The MongoDB server needs replica set configuration.

## Preserve the existing database

Before changing the database service, take and verify a backup. Keep the existing
MongoDB image version and data volume when converting it. Do not delete the
service, recreate an empty volume, or change the application's database name.

The deployed URI shown during this investigation has no database name after the
host. Mongoose normally selects `test` when none is provided. Check the current
database before choosing a name; do not assume it is `appointment_scheduler`.

## Dokploy configuration

Open the **MongoDB service**, rather than the application's logs. The exact
replica set controls depend on the installed Dokploy version. Dokploy's MongoDB
service schema supports `replicaSets`, and its implementation uses the name
`rs0` when that setting is enabled.

The public Dokploy implementation inspected for this investigation starts its
built-in replica mode without `--auth` or `--keyFile`. Do not enable that mode
while leaving MongoDB's port publicly reachable. Use its internal network and
remove public exposure, or configure an authenticated replica set with keyfile
authentication. The installed version and database settings must be checked
before applying a production change.

For an authenticated private replica set, the application URI has this shape:

```dotenv
MONGODB_URI=mongodb://USER:URL_ENCODED_PASSWORD@INTERNAL_MONGO_HOST:27017/CURRENT_DATABASE?authSource=admin&replicaSet=rs0
```

Use the actual replica set name and hostname. Every advertised replica set host
must be reachable by the application. If TLS is configured, add its connection
options. For a trusted private Docker network without TLS, this application
requires `MONGODB_ALLOW_PLAINTEXT_INTERNAL=true` and an internal service hostname;
that opt-in does not allow a public IP address.

Set the deployed application's variables in **Dokploy → Application →
Environment**. Editing the developer machine's `.env` does not update Dokploy.

## Verify before retrying business actions

Once the new diagnostic script is deployed, run in the application container:

```sh
npm run db:check -- --require-transactions
```

This checks the connection, database name and read-only `hello` metadata. It does
not create accounts, payments, orders or bookings. A successful configuration
reports `topology=replica_set`, `writable primary=true` and
`transactions configured=true`. This reports server configuration, rather than
proving the application user has every workflow permission.

After configuration, restart the application and verify one intended action,
including its related order/payment or booking records. Do not bulk retry failed
actions before checking their current status.

## References

- [MongoDB transaction requirements](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/)
- [Convert an existing standalone server to a replica set](https://www.mongodb.com/docs/manual/tutorial/convert-standalone-to-replica-set/)
- [Dokploy MongoDB service implementation](https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/databases/mongo.ts)
- [Dokploy MongoDB service settings](https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/db/schema/mongo.ts)
