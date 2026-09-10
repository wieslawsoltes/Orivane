# Operations, backup and recovery — 0.2

Backups contain board content, account hashes, session state, room invitation hashes and operational records. Protect/encrypt them at the storage layer and restrict access. The tools do not provide backup encryption, off-site scheduling, automatic failover, retention policy enforcement for backups or disaster-recovery certification.

## Local file store

Stop the app cleanly, then run:

```sh
node tools/admin.js backup-files ./data ./backups/new-snapshot
```

The destination must not exist. The tool acquires the same exclusive writer lock as the application, copies all active keys and durably commits them in the new directory. Running against a live local writer fails rather than copying an inconsistent account/document state.

Restore with the application stopped, point `DATA_DIR` at the backup directory, and restart. Keep the original directory unchanged until the restored app passes readiness and board checks. Only run one writer per local directory.

A normal stale `.writer.lock` from a crashed process on the same host is recovered after checking the process ID. Initialization uses a short-lived `.writer.startup` guard. A crash during initialization can leave that startup marker. Inspect its PID/host and verify no application/backup/migration process is running before manually removing it. Never remove a live lock to force multiple writers; use shared storage instead. Locks from another hostname and unreadable locks require operator inspection rather than unsafe automatic takeover.

## SQLite authority

The native backup tool reads committed SQLite state using `VACUUM INTO` and verifies `PRAGMA integrity_check` on the result:

```sh
node tools/admin.js backup-sqlite ./data/cluster.sqlite ./backups/new-snapshot.sqlite
```

This was tested while the source database's WAL connection remained open. Do not copy only the main live `.sqlite` file and ignore WAL state. The destination must not already exist. Set restrictive permissions and move completed backups to protected storage.

To restore, stop all API workers and the storage node. Restore into a **new clean database path** with no old `-wal`/`-shm` sidecars; set `CLUSTER_DB` to that path. Start storage, verify its authenticated health endpoint, then start the workers. Treat existing sessions from the restored snapshot according to your security policy; restoring an older database can also restore previously revoked authorization state.

For containers, run the admin tool where it has access to the mounted database. Example backup within the storage volume:

```sh
docker compose exec storage node tools/admin.js backup-sqlite \
  /app/data/cluster.sqlite /app/data/backups/new-snapshot.sqlite
```

The container command is supplied but not runtime-tested here. Copy the completed backup off the same storage volume; a same-volume backup alone does not protect against disk loss.

## File-store to shared-store migration

Stop the old app, back up its directory, start an empty storage authority, then run:

```sh
CLUSTER_STORAGE_URL=http://127.0.0.1:4174 CLUSTER_SECRET='<secret>' \
  node tools/admin.js migrate ./data
```

The tool refuses overlapping target keys. Migration is a sequence of durable key writes, not one cross-key transaction; use an empty destination with no clients. On failure, discard/reset the incomplete destination after inspection and migrate again from the preserved source. Only switch API workers after the migration completes. A connection failure releases the source writer lock.

## Password recovery

Host administrators can recover local password accounts without an unauthenticated reset endpoint:

```sh
ORIVANE_RECOVERY_PASSWORD='<new-strong-password>' DATA_DIR=./data \
  node tools/admin.js reset-password user@example.org
```

Stop the local file-store app first. Shared storage can instead be selected with `CLUSTER_STORAGE_URL`/`CLUSTER_SECRET`. The command uses a new scrypt hash, revokes existing sessions through the account version, and records an administrative audit event. Use an appropriate secret-input mechanism on shared hosts; shell/environment values can be exposed through history/process administration. SSO accounts must be recovered through the IdP, not this password tool.

## Monitoring and capacity

Monitor per-worker readiness, storage errors, rejected requests, active streams, disk space, snapshot size and outbox states. Check room/workspace audit exports and saved version counts. Audit `retentionDays` trims old audit metadata, not live board data. Expired sessions and completed jobs are no longer usable but are not comprehensively garbage-collected; account for retained database keys and audit/version/tombstone growth.

Storage outages produce failures rather than successful edit acknowledgements. Clients keep unacknowledged operations and reconnect. Validate a recovery on your hardware/storage stack; fsync/SQLite settings do not certify the underlying storage system against every failure mode.

For a substantial installation, add a reviewed backup schedule, secret management, abuse controls, operational dashboards, load tests, retention/erasure tooling and a replicated database design before claiming an enterprise SLA.
