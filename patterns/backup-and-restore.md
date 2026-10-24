# Backup and Restore

This app's database holds the business. Backups are not complete until someone has restored one and verified the app can read it.

## Choose a backup profile

Pick one profile and record it in `notes/03-hosting.md`. **The default is full logical backups on the in-container schedule**, because the documented deploy target is Dokploy on a VPS and Dokploy cannot run the one-shot profile: its **Schedule Jobs** are `docker exec` commands inside *already-running* containers, so they can never stand up the db-applier image on a timer. A long-lived db-applier service running its own cron is the shape that works there.

| Profile | When to use | Scheduled dumps | Pre-apply dump | Restore path |
| --- | --- | --- | --- | --- |
| **Full logical backups (in-container schedule)** *(the default — Dokploy, any VPS, Docker Compose)* | The host has no way to launch a one-shot container on a schedule | `DB_APPLIER_MODE=schedule` long-lived service | Yes (when toggles true + S3 configured) | db-applier one-shot job |
| **Full logical backups (external cron)** | The host *can* launch a one-shot container on a timer (a cron runner, a Kubernetes `CronJob`, a plain `crontab` on the VPS invoking `docker run`) | External scheduler → db-applier `backup` mode | Same as above | db-applier one-shot job |
| **Provider-only (opt-in)** | Simple apps; owner accepts snapshot-grid recovery only | None (remove the schedule service) | No (`BACKUP_PRE_APPLY_ENABLED=false`) | Provider/platform UI only |

**Do not run an external cron and in-container `schedule` mode against the same database** — you would double-schedule dumps, double the cost, and be unsure which copy to restore.

### The two backup identities (both full profiles)

Configure **two** dedicated credentials against the backup bucket, whichever profile you pick. The dump-writer pair `BACKUP_S3_*` (GetObject/PutObject/AbortMultipartUpload) goes to the schema leader and to the backup service; the ListBucket-only `BACKUP_MONITOR_S3_*` pair goes to the runtime that runs the freshness check, and that runtime receives only the monitor pair. A job that holds database credentials must never inherit the app's auth/SMTP/push/LLM secrets, so grant each identity its own pair on its own service rather than sharing one environment block. Rotate each backup pair where the schema leader's env is configured. If you deliberately select the worker as the schema leader, prepare its dump-writer pair before activating it — never grant the dump pair merely for freshness.

The non-secret knobs (`BACKUP_S3_REGION`, `BACKUP_S3_PREFIX`, `BACKUP_S3_FORCE_PATH_STYLE`, `BACKUP_ENABLED`, `BACKUP_CRON`, `BACKUP_MAX_AGE_HOURS`) are plain env values. A dump key is always nested under `BACKUP_S3_PREFIX/<sha256(canonical-target)>/`; a host or database migration deliberately creates a new namespace and needs a newly proven backup rather than inheriting the old one's provenance.

With `BACKUP_ENABLED=true` but the bucket not configured yet, `backup` mode **skips and exits 0**, printing the exact variables to set. That is the state of a first deploy, before you have made a bucket — and a nightly job that goes red at that point only teaches you to ignore it. Nothing is uploaded and nothing claims otherwise: the freshness check below is what tells you backups are missing, and it is on by default. `apply` mode is *not* this forgiving — `APPLY_SCHEMA=dangerous` still refuses to run without a pre-apply dump.

### Full logical backups (in-container schedule) — the default

This is the Dokploy default. Its Application settings, env-var table, and release selection live in [deployment-vps.md § 11. Enable Postgres backups](./deployment-vps.md#11-enable-postgres-backups) — follow that section for the click path; this one owns the contract behind it.

1. Deploy `Dockerfile.db-applier` as a **long-lived service** (not a one-shot), one replica, ordinary restart-on-failure.
2. Set `DB_APPLIER_MODE=schedule`, `BACKUP_CRON`, `BACKUP_ENABLED=true`, `DATABASE_URL`, and `BACKUP_S3_*`.
3. The entrypoint writes `/app/db-applier.env` and runs `cron -f`. Each tick sources that file before `./scripts/db-applier.sh backup`.
4. Do **not** also run an external cron, or the platform's own managed backup, against the same database.

The image deliberately has **no default command**. The mode is the container's command if one is given, otherwise `DB_APPLIER_MODE`, otherwise `backup`. So `DB_APPLIER_MODE=schedule` with no command starts the scheduler — a baked-in default command would have overridden it and quietly run a single one-shot dump instead. If your platform *does* set a command, it wins: the external-cron profile passes `backup` as the command on purpose.

`BACKUP_CRON` must be a plain 5-field cron expression on one line (`minute hour day-of-month month day-of-week`) — no seconds field. The entrypoint checks the shape before writing it into the container's crontab and refuses to start if it is wrong, because a malformed line would leave you with a scheduler that never fires and says nothing.

```yaml
# docker-compose example (illustrative — `pnpm dokploy:config` generates the
# reviewed copy, with this service commented out ready to enable)
services:
  db-backup:
    build:
      dockerfile: Dockerfile.db-applier
    environment:
      DB_APPLIER_MODE: schedule
      BACKUP_CRON: "0 3 * * *"
      BACKUP_ENABLED: "true"
      DATABASE_URL: ${DATABASE_URL}
      BACKUP_S3_BUCKET: ${BACKUP_S3_BUCKET}
      BACKUP_S3_ACCESS_KEY_ID: ${BACKUP_S3_ACCESS_KEY_ID}
      BACKUP_S3_SECRET_ACCESS_KEY: ${BACKUP_S3_SECRET_ACCESS_KEY}
      BACKUP_S3_REGION: ${BACKUP_S3_REGION:-auto}
      BACKUP_S3_ENDPOINT: ${BACKUP_S3_ENDPOINT}
      BACKUP_S3_PREFIX: ${BACKUP_S3_PREFIX:-database}
      BACKUP_S3_FORCE_PATH_STYLE: ${BACKUP_S3_FORCE_PATH_STYLE:-false}
      # Non-secret comparison ID — backup.sh refuses BACKUP_S3_* that matches S3_ACCESS_KEY_ID.
      S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID}
    restart: unless-stopped
```

### Full logical backups (external cron)

An external scheduler invokes the db-applier image in `backup` mode. The container runs **once**, dumps, uploads, and exits. You do **not** set `DB_APPLIER_MODE=schedule`.

1. Have the scheduler run the db-applier image with `backup` as the command (mode only — the image entrypoint parses this).
2. Put the schedule in the scheduler's own config and keep it aligned with `BACKUP_CRON` (`0 3 * * *` by default) — an external scheduler does not read `BACKUP_CRON` from env at runtime.
3. Give that job the dump-writer identity and nothing else, per § The two backup identities above.

### Provider-only profile (opt-in)

For small apps where the owner relies on the **platform's own database snapshots only** — on Dokploy, its database **Backups** tab (an S3 destination, a daily snapshot, a retention window). No logical dumps, no db-applier schedule service. Schema leadership is a separate choice: prefer the applier Application, or use the supported app-entrypoint fallback.

1. **Do not deploy** the `db-backup` schedule service (or delete it if you already have).
2. On the selected schema leader and any runtime running backup freshness checks, set:
   - `BACKUP_ENABLED=false`
   - `BACKUP_PRE_APPLY_ENABLED=false`
3. Leave every `BACKUP_S3_*` value unset on the services that no longer need it.
4. Schema changes still use the selected leader; disabling logical backups does not make a worker the leader. On Dokploy without an applier, keep the **app** entrypoint `APPLY_SCHEMA=safe` on ordinary Git deployments and any worker `off` + `WAIT_FOR_SCHEMA=true`. A separate apply Application can also use provider-only backups. Only the pre-apply pg_dump is skipped; dangerous changes still need their one-use confirmation and provider-backup acknowledgement.
5. Document in `notes/03-hosting.md` that recovery is snapshot-only and run a **restore drill from a platform snapshot** before production traffic.

This profile trades portability and long retention for simplicity. Be honest with the owner about what it buys: **restore points on a 24-hour grid, not point-in-time recovery.** Everything written between the last snapshot and the incident is gone, and a snapshot living in the same platform account as the database it protects is one compromised account away from being no backup at all. It is appropriate only when that recovery window genuinely meets the business's needs.

## Recommended production posture

On the documented target — Dokploy on a VPS — **there is no provider safety net under you.** Postgres is a container on a machine you rent; nobody is taking snapshots of it until you configure something that does. That is the whole reason the logical-backup profile is the default here rather than an upgrade.

So the posture is:

1. **Logical `pg_dump` backups to object storage off the VPS** — the schedule service above. This is the layer that survives losing the whole machine, and the only one this template can set up for you.
2. **Optionally, the platform's own snapshots as well** (Dokploy's database Backups tab), for a faster path back from an ordinary mistake. Two layers is better than one; if you enable both, they must not both be dumping logically — the managed tab is the *provider-only* profile's mechanism, and doubling up on `pg_dump` is the mistake called out above.

Whatever you choose: it is not a backup until you have restored it. See [§ Restore drill](#restore-drill).

## Environment toggles

| Variable | Default | Effect |
| --- | --- | --- |
| `BACKUP_ENABLED` | `true` | When `false`, manual/scheduled backup runs log a warning and skip the dump. |
| `BACKUP_PRE_APPLY_ENABLED` | `true` | When `false`, `APPLY_SCHEMA` deploys skip the pre-push pg_dump and log a warning. |
| `BACKUP_CRON` | `0 3 * * *` | Canonical schedule string. **In-container schedule (the default):** read at schedule-service startup. **External cron:** mirror it in the scheduler's own config; nothing reads this var at runtime there. |
| `BACKUP_MAX_AGE_HOURS` | `36` | How old the newest dump may get before the worker calls backups stale. See [§ Knowing backups ran](#knowing-backups-ran). |
| `BACKUP_HEARTBEAT_URL` | *(unset)* | Optional dead-man's-switch URL, pinged after each successful upload. See [§ Knowing backups ran](#knowing-backups-ran). |

Backup writers use **`BACKUP_S3_*` only** — never the app upload key (`S3_*`) — and require a distinct GetObject/PutObject/AbortMultipartUpload identity. The freshness worker uses **`BACKUP_MONITOR_S3_*` only**, a distinct ListBucket identity; it never reads or writes a dump. Writer-key reuse or a writer-only missing key is refused where a dump/restore would occur, while monitor-key mistakes produce a freshness `misconfigured` verdict. A shared invalid region or missing bucket is warned at boot without crashing the site.

## Dokploy setup (the default walkthrough)

Everything here happens in the Dokploy UI and in object storage. **Nothing in this section asks your laptop to reach production Postgres, Redis, or the app's S3 bucket** — it cannot, and it should not be able to.

1. **Create the backup bucket** at any S3-compatible provider (R2, B2, MinIO, AWS). Private, **versioning on** ([§ Bucket retention, versioning, and incomplete uploads](#bucket-retention-versioning-and-incomplete-uploads)), with a lifecycle rule for retention and one for aborting incomplete multipart uploads.
2. **Mint two separate credentials** against it — a dump-writer pair (`GetObject` + `PutObject` + `AbortMultipartUpload`) and a monitor pair (`ListBucket` only). They are not interchangeable and the scripts refuse to treat them as such; the rules are in [§ Choose a backup profile](#choose-a-backup-profile) above.
3. **Create the `db-backup` Application** — Git source, `Dockerfile.db-applier`, build context `.`, no domain, no command override, one replica, ordinary restart-on-failure. The exact click path and the full env-var table are in [deployment-vps.md § 11. Enable Postgres backups](./deployment-vps.md#11-enable-postgres-backups).
4. **Set the env vars on that Application, not at the project level.** This is the rule that matters most and the one that is easy to get wrong in a UI that offers a shared environment: the backup service must never inherit the app's auth/SMTP/push/LLM secrets, and the app must never inherit the dump-writer key.

   | Where | Which variables |
   |---|---|
   | `db-backup` Application | `DB_APPLIER_MODE=schedule`, `BACKUP_CRON`, `BACKUP_ENABLED=true`, `DATABASE_URL`, `BACKUP_S3_BUCKET`, the **dump-writer** `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_REGION`, `BACKUP_S3_ENDPOINT` and `BACKUP_S3_FORCE_PATH_STYLE` for non-AWS storage, `BACKUP_S3_PREFIX`, and optionally the non-secret `S3_ACCESS_KEY_ID` so the writer can prove it is not reusing the app's upload credential |
   | The runtime that runs the freshness check — the app (embedded jobs) or the dedicated worker | `BACKUP_ENABLED=true`, `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION` / `BACKUP_S3_ENDPOINT` / `BACKUP_S3_PREFIX`, `BACKUP_MAX_AGE_HOURS`, and the **monitor** `BACKUP_MONITOR_S3_ACCESS_KEY_ID` / `BACKUP_MONITOR_S3_SECRET_ACCESS_KEY`. Never the dump-writer pair. |
   | The schema leader (the `schema-apply` Application, or the app entrypoint when there is no applier) | The dump-writer `BACKUP_S3_*` set, so the pre-apply dump can run |

5. **Do not also enable Dokploy's managed backup** on the same database. Two schedules means double dumps, double cost, and no clarity about which copy you restore.
6. **Record the choices** in `notes/03-hosting.md` — bucket, region/endpoint, prefix, cron, retention window — and run one restore drill before you rely on any of it.

`scripts/backup.sh` writes custom-format dumps (`pg_dump -Fc`), smoke-checks with `pg_restore --list`, then uploads when S3 is configured.

### Confirming the first backup actually ran

Do this the morning after the first scheduled tick, not at the incident:

1. **Read the `db-backup` container's logs** in Dokploy. Cron writes each run to `/var/log/db-applier-backup.log` and the entrypoint tails it to stdout, so a successful run appears in the ordinary log viewer and ends with the `Restore source: RESTORE_BACKUP_S3_KEY=… RESTORE_BACKUP_S3_ETAG=…` line. Copy that line somewhere — it is exactly what a restore needs.
2. **Look in the bucket.** There should be an object under `BACKUP_S3_PREFIX/<target-id>/backup-YYYYMMDD-HHMMSS.dump`, with a plausible size. An exit code of 0 is not enough on its own: with `BACKUP_ENABLED=true` and no bucket configured, `backup` mode deliberately **skips and exits 0**.
3. **Check `/admin`** once the freshness job has had a cycle (it runs every six hours). A green backup card is the app agreeing that a recent dump exists. See [§ Knowing backups ran](#knowing-backups-ran) for what each verdict means and why "no verdict yet" counts as a problem.

Schema apply (dedicated applier or app entrypoint) takes a pre-apply dump when BACKUP_ENABLED=true, BACKUP_PRE_APPLY_ENABLED=true, and backup storage is configured. A dangerous apply requires `APPLY_SCHEMA_CONFIRM` to bind the target and schema fingerprint; the required backup precedes a final identical-plan check. An empty schema still publishes an atomic success receipt without a needless backup.

Ordinary apply holds its advisory lock and executes schema SQL on one PostgreSQL session. The SQL and the schema receipt commit atomically in one transaction, so an interrupted apply is either fully applied or fully rolled back. An acknowledged rollback is retryable; after a connection loss, verify the outcome with read-only queries before retrying rather than assuming either way.

## Knowing backups ran

A backup that stopped running is silent. Nothing errors, no page goes down, and you find out the day you need the dump. Three things in this template make that impossible to miss — the first is on by default, the second is one optional URL, the third is just where the logs go.

### 1. The worker checks the bucket every 6 hours (on by default)

The worker job `check-backup-freshness` lists the backup bucket and looks at **one number: how old the newest dump is**. That single measurement covers every way backups can fail — the cron never fired, the container crashed, the credentials expired, the upload failed — because all of them end with "nothing new arrived".

- **Runs** every 6 hours whenever `BACKUP_ENABLED=true`, even before a bucket exists (the verdict is `setup-missing` until `BACKUP_S3_BUCKET` is set). Nothing else to configure.
- **Stale means** the newest dump is older than `BACKUP_MAX_AGE_HOURS` (default `36` — a day and a half, so one skipped nightly run is a hiccup and two is an alert).
- **When it needs attention:** a status card appears on `/admin`, and admins with operational alerts enabled get an email (at most one a day while the problem lasts). A bucket that is set but **misconfigured** (a missing or reused key pair, or `BACKUP_S3_REGION=auto` with no `BACKUP_S3_ENDPOINT`) shows on that card as "backups are turned on but set up incorrectly", with the exact variable to fix — it never reads as "backups are off", because that state takes no backups at all.
- **The email needs SMTP.** It is sent through the same `SMTP_*` configuration as everything else, only to admins who have `emailVerified` and operational alerts switched on. With SMTP unconfigured — or on a Redis outage, when the once-a-day cooldown cannot be reserved — no email is sent and nothing warns you that none was. **The `/admin` card is then your only signal**, so if you are running without SMTP, make opening `/admin` part of your routine (or set `BACKUP_HEARTBEAT_URL` below, which does not depend on your app at all).
- **"No verdict yet" counts as needing attention**, not as healthy. An empty bucket, a bucket it could not read, and a check that has not run since the worker restarted all read as a problem. Something you have never verified is not a backup.

**Give the monitor key `ListBucket`.** The freshness check reads the *list* of objects in the bucket, not their contents. `BACKUP_MONITOR_S3_*` is scoped to ListBucket on the backup bucket; it needs neither GetObject nor PutObject. The separate `BACKUP_S3_*` dump-writer key stays scoped to GetObject/PutObject/AbortMultipartUpload. Do not give the worker the dump key merely to make freshness work.

### 2. `BACKUP_HEARTBEAT_URL` — an outside witness (optional)

The freshness check runs inside your app. If the whole deployment is down, so is the thing that would have told you. A dead-man's switch fixes that: an outside service expects a ping on a schedule and alerts *you* when it stops arriving.

Set `BACKUP_HEARTBEAT_URL` to the ping URL from [healthchecks.io](https://healthchecks.io), Cronitor, an Uptime Kuma push monitor, or any endpoint of your own that answers `2xx`. `scripts/backup.sh` GETs it **once, only after a dump has been uploaded off-site** — so the ping means "a dump landed in the bucket", never "the script started".

- Not set → nothing happens; this is entirely optional.
- Set, but `BACKUP_S3_BUCKET` is not → no ping, and a warning in the log. There is no off-site dump to attest to.
- Ping fails (timeout, 500, DNS) → warning in the log, **the backup still succeeds**. The dump is already safe, and the monitor raises the alarm on its own.

The URL usually contains a secret token, so treat it as one: set it as a secret env var on the `db-backup` Application (the service that actually pings it), not in a shared environment group. The scripts only ever print its hostname.

### 3. Schedule-mode logs reach the container log

In the in-container `schedule` profile, cron writes each run to `/var/log/db-applier-backup.log` inside the container. The entrypoint also tails that file to stdout, so every run — and every failure — shows up in your platform's normal log viewer alongside everything else. Nothing to enable.

### The `PG_MAJOR` rule when you upgrade Postgres

`pg_dump` can dump a database **older** than itself, never a newer one. The three Dockerfiles pin the Postgres client major with `ARG PG_MAJOR` (from the upstream PGDG apt repository). **When you upgrade the database major version, bump `PG_MAJOR` in `Dockerfile`, `Dockerfile.worker`, and `Dockerfile.db-applier` to match, and rebuild the images.** Two guards make forgetting loud instead of silent:

- `pnpm docker:check-copy` (part of `pnpm verify`) fails if the three Dockerfiles disagree.
- `scripts/backup.sh` asks the live server for its version before dumping and refuses, with instructions, if the client is older.

## Restore drill

Run at least quarterly and before any `APPLY_SCHEMA=dangerous` production deploy (logical-backup profiles).

> **A drill must never use your production `DATABASE_URL`.** Create a separate empty database and give only its URL to the restore job. The default `RESTORE_TARGET_MODE=empty-target` refuses a destination containing application objects. Keep that check enabled for drills and ordinary recovery.

### On Dokploy

The drill runs entirely on the VPS, in the Dokploy UI. Your laptop never needs a route to the production database, to Redis, or to the app's object storage.

1. **Create the throwaway database.** Add a Postgres database to the project, name it something unmistakable like `postgres-restore-drill`, same major version as production. Do not give it a public port. Copy its **internal** connection URL from its overview page.
2. **Pick a dump.** The newest `db-backup` log line ends with `Restore source: RESTORE_BACKUP_S3_KEY=... RESTORE_BACKUP_S3_ETAG=...` (plus `RESTORE_BACKUP_S3_VERSION_ID=...` on a versioned bucket) — copy those values verbatim into step 3; the ETag must match the object byte-for-byte, quotes included. When the logs have rotated away, take the newest object key under its target-id namespace in the bucket console, e.g. `database/<target-id>/backup-YYYYMMDD-HHMMSS.dump`, and read its ETag (and version ID) from the console or `aws s3api head-object`.
3. **Create a one-shot `restore-drill` Application** from `Dockerfile.db-applier` — the same shape as the `schema-apply` Application, with **restart condition `none`** (Advanced → Swarm Settings → Restart Policy) so a successful run stays terminal instead of looping. No domain, no command override, one replica. Set these variables **on that Application only**, never in a shared environment group:
   - `DATABASE_URL` = **the drill database's internal URL from step 1**, typed in as a plain literal. Do not reference the production database, and do not copy the env block from the app — that substitution is how a drill becomes an outage.
   - `DB_APPLIER_MODE=restore` (or container command `restore`). Either works: the image has no default command, so leaving the command blank and setting the mode is enough.
   - `RESTORE_BACKUP_S3_KEY` = the key from step 2
   - `RESTORE_BACKUP_S3_ETAG` = the exact ETag from step 2; optionally `RESTORE_BACKUP_S3_VERSION_ID`
   - `APPLY_SCHEMA=off`
   - the `BACKUP_S3_*` values — it has to read the dump out of the bucket
4. **Deploy it once and read the log.** Without `RESTORE_CONFIRM` this run is a preview: it downloads and validates the source, then prints the drill target id and the immutable source SHA-256 without mutating anything.
5. **Add the confirmation and redeploy.** Set `RESTORE_CONFIRM=RESTORE:<target-id>:<source-sha256>:<fresh-nonce>` and `RESTORE_CONFIRM_NONCE=<fresh-nonce>` from the preview output, then deploy the Application again. This run checks the drill database is empty, restores, and ends with `Restore complete.`
6. **Verify the data is actually there**, not just that the task went green. Open a shell into the **drill Postgres container** (Dokploy's terminal for that service, or `docker exec -it <drill-container> psql -U postgres`) and look at a table you would notice the loss of:
   ```sql
   \dt
   SELECT count(*) FROM "user";
   SELECT max("createdAt") FROM "user";
   ```
   The newest row should be from shortly before the dump was taken. A correct schema with empty tables is a **failed** drill.
7. **Delete the drill database and the `restore-drill` Application.** Both. A reusable target or a leftover `RESTORE_*` variable is exactly the hazard the mode guards exist for.
8. **Record it** in `notes/03-hosting.md`: date, which dump key, how long the restore took, and anything that surprised you.

### Locally

Same shape, with a container as the throwaway database. The Dokploy drill above is the one to run against a real deployment; this one is for working on the restore path itself, or for proving a dump is readable without touching the VPS at all.

It is also the only place in this doc that puts backup credentials on your laptop. The one thing it reaches across the network for is the **backup bucket** — never production Postgres, Redis, or the app's upload bucket, none of which it needs or should be able to reach. Prefer a read-only key scoped to the backup bucket over pasting in the dump-writer pair.

You need three things on your own machine first, because this runs the repo's scripts directly rather than the db-applier image:

- **`pg_restore` and `psql`** on your `PATH` — the Postgres client tools, at a major version **at least** as new as the database the dump came from (`postgresql-client-17` on Debian/Ubuntu, `brew install libpq` on macOS). Without them the restore fails immediately with `command not found`.
- **Docker**, for the throwaway database container.
- **`pnpm install` in the repo**, since the restore downloads the dump with the workspace's own S3 helper.

Then:

```bash
docker run -d --name restore-drill -e POSTGRES_PASSWORD=drill -p 55432:5432 postgres:17

# Run 1 — preview only. Without RESTORE_CONFIRM this never mutates the
# database; it prints the drill target id and the immutable source SHA-256.
DATABASE_URL=postgresql://postgres:drill@localhost:55432/postgres \
DB_APPLIER_MODE=restore \
RESTORE_BACKUP_S3_KEY=database/<target-id>/backup-YYYYMMDD-HHMMSS.dump \
RESTORE_BACKUP_S3_ETAG='<exact-etag>' \
APPLY_SCHEMA=off \
BACKUP_S3_BUCKET=... BACKUP_S3_ACCESS_KEY_ID=... BACKUP_S3_SECRET_ACCESS_KEY=... \
  ./scripts/db-applier.sh restore

# Run 2 — confirmed restore. Substitute <target-id> and <source-sha256> from
# run 1's "Restore plan" output; pick a fresh nonce and use the same value in
# both variables. This run checks that the destination has no application
# objects, then restores into it without replacing the original database.
DATABASE_URL=postgresql://postgres:drill@localhost:55432/postgres \
DB_APPLIER_MODE=restore \
RESTORE_BACKUP_S3_KEY=database/<target-id>/backup-YYYYMMDD-HHMMSS.dump \
RESTORE_BACKUP_S3_ETAG='<exact-etag>' \
RESTORE_CONFIRM=RESTORE:<target-id>:<source-sha256>:<fresh-nonce> \
RESTORE_CONFIRM_NONCE=<fresh-nonce> \
APPLY_SCHEMA=off \
BACKUP_S3_BUCKET=... BACKUP_S3_ACCESS_KEY_ID=... BACKUP_S3_SECRET_ACCESS_KEY=... \
  ./scripts/db-applier.sh restore

psql postgresql://postgres:drill@localhost:55432/postgres -c 'SELECT count(*) FROM "user";'
docker rm -f restore-drill
```

Note the port: `55432`, not `5432`. The drill container must not be the Postgres your app develops against, and the `DATABASE_URL` above is the drill container's — never the one in your `.env`.

## Restoring a logical dump

Recovery has two parts: restore the dump into a new empty database, then complete [§ Replacement database recovery handoff](#replacement-database-recovery-handoff). `Restore complete.` confirms the data restore only. Dumps exclude `starter_control`, and restore does **not** publish a schema receipt. Even an identical restored schema needs an ordinary guarded apply from the selected release before followers can start. Keep the original database intact.

The default `RESTORE_TARGET_MODE=empty-target` checks all application catalogs, including schemas, tables, sequences, functions, types, and extensions. It allows only a fresh destination plus its own `starter_control` receipts, and never clears `public`. The job renders the archive with `pg_restore`, validates its PostgreSQL 17 preamble before consuming approval, then streams its unchanged body through psql in one transaction. An existing destination is refused before application mutation. After the job exits, remove every `RESTORE_*` variable, correct the target, and preview and confirm again with a fresh nonce.

Natural shell errors and caught cancellation clean the source and nested snapshot artifacts after draining their writers. A failure after the destructive boundary has begun leaves the outcome to the server: the restore writer applies it in one transaction, so the destination is either fully restored or rolled back, but client exit alone is never treated as proof of which.

An interrupted or failed restore must not be blindly retried: stop the original job, inspect the destination with read-only queries, and re-run against a fresh empty target (or a verified in-place state) once the outcome is established. The original application database is still available in the normal replacement workflow. The writer applies a 5-second table-lock wait, 60 seconds per statement, and a 30-minute total transaction budget **after** pg_restore's generated timeout resets and before any archive object/data. Only the bounded generated preamble is inspected; COPY rows are never searched or rewritten. A 1810-second client deadline and caught cancellation signal its direct psql client, escalating to a force-close after five seconds. Rendering has a separate 120-second deadline; backups remain outside the SQL budget.

Restore refuses other connections to its destination. In the normal workflow the running app continues to use the original database; stop any inspection clients connected to the replacement. A refusal happens before mutation, so after correcting it (and removing every `RESTORE_*` variable) a fresh preview and confirmation may be run. For unavoidable pooler/provider connections, `RESTORE_ALLOW_ACTIVE_CONNECTIONS=<the database name>` overrides that connection check only; it never bypasses empty-target validation.

**One-shot restore (dedicated db-applier, supported guarded entrypoint):**

1. Agree the recovery point and intended immutable release, then create a new empty destination on the same Postgres major. Point only this job at it. The original deployment may continue using its original database while the replacement is prepared, but writes after the dump are not included in the restored data. Plan a maintenance window for the handoff below.
2. Run a one-shot db-applier job in mode `restore` (container command `restore`, or `DB_APPLIER_MODE=restore`) with `RESTORE_BACKUP_S3_KEY`, its exact `RESTORE_BACKUP_S3_ETAG` (and optional version ID), and `APPLY_SCHEMA=off`. The applier conditionally downloads that exact source, validates it, then prints the target id and source SHA-256. Re-run with a fresh `RESTORE_CONFIRM_NONCE` and `RESTORE_CONFIRM=RESTORE:<target-id>:<source-sha256>:<fresh-nonce>`. Set the restore variables on that job only — never on server or worker services, and never in a shared environment group.

   **On Dokploy**, "a one-shot job" is a dedicated Application built from `Dockerfile.db-applier` with **restart condition `none`** — the same shape as `schema-apply`, and the same shape as the drill above. Deploying it runs it once; deploying it again after editing its variables is how you go from the preview run to the confirmed run. Everything it needs arrives as environment variables typed into that Application's own env panel, which is the point: the operator never needs a network path from their own machine to the database. The app images retain `pg_restore` and backup helpers for legacy boot-time apply's required `pg_restore --list` verification; they are not a restore-capability sandbox. Their ordinary entrypoint rejects the **full** restore variable inventory, so only the explicit one-shot db-applier `restore` mode is supported and guarded.
3. The entrypoint runs restore, then exits.
4. Retire the one-shot run configuration, or remove **every** `RESTORE_*` variable and its `restore` command/mode before reusing it. Preserve its logs and immutable source identity. Removing only the key and confirmation is insufficient.
5. Complete the handoff below before declaring recovery complete. A drill can stop after read-only data validation; it has not tested application startup, cutover, or the replacement's backups.

Restore never fires from the variables alone. The mode must be `restore`; the `backup`, `apply`, and `schedule` modes refuse to start while any restore-only variable is set, so a forgotten key cannot turn a nightly backup cron or a legacy schema leader into a database replacement.

`RESTORE_CONFIRM` binds a canonical destination target id, the conditional-download source SHA-256 (key, ETag, and version), and a fresh nonce. Dumps exclude `starter_control`, so source records never overwrite target receipts.

**Exceptional in-place recovery:** if a separate destination is unavailable, stop and drain every writer, schema job, and backup runner in the handoff inventory below; set `RESTORE_TARGET_MODE=in-place` on the restore job and preview again. This mode requires the distinct `RESTORE-IN-PLACE:<target-id>:<source-sha256>:<fresh-nonce>` confirmation and an uploaded target snapshot before replacing `public`. An empty-target confirmation cannot authorize it. The connection check runs before the snapshot and again immediately before mutation. A failure after replacement may leave the destination unusable; keep the runtimes stopped, inspect with read-only queries, and re-run only from a verified state. After success, use the same selected-release apply, runtime, backup, and monitoring checks below. The URL may be unchanged and an older control receipt may remain, but neither proves the restored schema matches the selected release. Unlike replacement recovery, the original database is no longer intact, so switching its URL back is not a fallback.

```bash
DB_APPLIER_MODE=restore \
RESTORE_BACKUP_S3_KEY=database/<target-id>/backup-YYYYMMDD-HHMMSS.dump \
RESTORE_BACKUP_S3_ETAG='<exact-etag>' \
APPLY_SCHEMA=off \
  ./scripts/db-applier.sh restore
```

**Do not** set restore vars on web or worker — those entrypoints refuse to boot if they are present.

### Replacement database recovery handoff

Use this entire sequence after a successful replacement restore, including a provider-created replacement. These are operator steps; the scripts do not move services, stop old tasks, or undo a cutover. Keep a checklist in the incident record with the original and replacement resource names, dump identity, original running release, chosen recovery release, and each consumer below. Keep credentials in the hosting platform, out of that record and local `.env` files.

1. **Validate the data without starting a runtime.** Connect only a database inspection client to the replacement. In `psql`, use `BEGIN READ ONLY;`, inspect counts, newest timestamps, and representative records the owner expects from the chosen dump, then `ROLLBACK;` and disconnect. Compare the results with the accepted recovery point. Do not launch an isolated copy of the app or worker for this check: the app can send email directly and starts background consumers when `WORKER_MODE=embedded`. `WORKER_MODE=external` is not a switch that disables all effects. A database client running read-only queries needs no production Redis, SMTP, object-storage, or provider credentials. Application smoke checks happen after the deliberate runtime-start step below.
2. **Prepare and stop the original writers.** Pin all selected roles to the intended reviewed immutable release; suspend automatic deployments and pending deployment triggers during recovery. Arrange a maintenance window: block public ingress at the proxy/load balancer, pause external job producers and integrations, stop the app and any dedicated worker, and wait for all their tasks and in-flight jobs to drain. Include embedded jobs in app-only deployments. Stop or await every active schema job, backup run, and scheduled runner before changing its target. Confirm no old task is still writing; a rolling update with `start-first` can overlap old and new tasks. Keep Postgres and Redis running and preserve their data. Reconcile retained Redis jobs and external effects with the selected recovery point before starting consumers: jobs can refer to rows absent from an older dump, and previously sent email or webhooks cannot be undone. If the owner cannot establish which pending work is safe to resume, keep consumers stopped; never flush Redis as a recovery shortcut.
3. **Move every database consumer while it is stopped.** Update the destination connection and any direct provider resource binding for the complete inventory below. In Dokploy, change `environment.DATABASE_URL` and check each Application's explicit reference plus any literal override. Then **redeploy each affected Application/job using the new configuration**, in the order below. Editing a shared reference alone leaves running containers on the old value; restarting an old container without updating its service configuration can do the same. The schedule container also snapshots its environment into `/app/db-applier.env` at startup. Verify the newly selected tasks and the connection target through the platform's private configuration/connection view without printing secrets.

   | Consumer | Required handoff |
   |---|---|
   | App, including embedded background jobs | Replacement `DATABASE_URL`, selected release, existing leader/follower settings; fresh task after the leader step below. |
   | Dedicated worker, when selected | Replacement `DATABASE_URL`, same release, follower gate; includes its backup-freshness scheduler. |
   | Separate schema applier, when selected | Replacement `DATABASE_URL`, same release, ordinary `apply` command and `APPLY_SCHEMA=safe`; no restore or stale confirmation variables. |
   | `db-backup` schedule service, or an external backup runner | Replacement target in the service **and** recurring job definition; redeploy/recreate the configured task, with exactly one active schedule for this database. Stop the original schedule. |
   | Backup freshness and external monitoring | App/worker monitor configuration must cover the replacement's target namespace; retain the ListBucket-only monitor identity. Check `/ready`, backup status, and missed-backup heartbeat routing. Old-target pings must not keep the replacement's alert green. |
   | Provider/managed backup policy and other direct DB clients | Bind backups/PITR to the replacement resource where used, with the chosen retention and alerts. Update inspection tools, integrations, and any independent job/deploy configuration that stores the original connection. |

4. **Run the selected schema leader before its followers.** Use the release chosen for recovery, which may differ from the release that made the dump. Run its ordinary guarded `apply` with `APPLY_SCHEMA=safe` against the replacement, even when the schema appears identical. This validates/establishes the live schema and writes the replacement's own matching receipt. Never insert a receipt by hand or copy source control state. Clear every restore variable first. For Dokploy the four supported layouts are:

   | Selected roles | First deployment against the replacement | After successful apply |
   |---|---|---|
   | App | App entrypoint: `APPLY_SCHEMA=safe`, `WAIT_FOR_SCHEMA=false`, `WORKER_MODE=embedded` | The app starts HTTP and embedded jobs after apply. |
   | App + applier | Applier: command `apply`, `APPLY_SCHEMA=safe`; wait for this task's exit 0 | Deploy app with `APPLY_SCHEMA=off`, `WAIT_FOR_SCHEMA=true`, `WORKER_MODE=embedded`. |
   | App + worker | App entrypoint: `APPLY_SCHEMA=safe`, `WAIT_FOR_SCHEMA=false`, `WORKER_MODE=external` | Deploy worker with `APPLY_SCHEMA=off`, `WAIT_FOR_SCHEMA=true`. |
   | App + applier + worker | Applier: command `apply`, `APPLY_SCHEMA=safe`; wait for this task's exit 0 | Deploy app and worker with `APPLY_SCHEMA=off`, `WAIT_FOR_SCHEMA=true`; app uses `WORKER_MODE=external`. |

   An app entrypoint leader starts the runtime immediately after apply, so finish the queue/effect review in step 2 **before** that deployment. Likewise an app follower with embedded jobs begins consuming as soon as admission passes, before public traffic is reopened. On any other platform, use whichever single leader you selected there and enable `safe` for this recovery apply even if its usual steady state is `off`. Confirm actual `Schema sync complete.` and successful task completion/startup; a build-success notification is insufficient. If `safe` refuses, keep the replacement closed and review the release/schema mismatch. Any necessary destructive change follows the existing [schema confirmation recipe](./deployment-vps.md#schema-deploy-lifecycle) with its own reviewed plan, backup, and fresh approval; restore approval cannot authorize it. Do not disable `WAIT_FOR_SCHEMA` to get past a missing receipt or live drift.
5. **Verify runtime and backup recovery before reopening traffic.** Deploy any remaining followers from the same release, then run the [Dokploy deployment verifier](./deployment-vps.md#10-git-builds-and-deployment-checks) with the roles actually selected (other hosts: their task/health checks plus `/ready`). Use a controlled access path for sign-in and representative application reads while ordinary public ingress remains blocked. Check the expected restored records again. A failure or gate timeout keeps traffic closed; inspect the selected leader, target, receipt, and live schema before retrying.

   For logical backups, redeploy the configured backup scheduler against the replacement and trigger a `backup` run using that scheduler's actual updated environment (Dokploy: a one-time `./scripts/db-applier.sh backup` execution inside the new `db-backup` container). Use the platform's equivalent for a cron runner. A zero exit alone is insufficient: backup mode can skip when storage is not configured. Require an uploaded object with recorded key, exact ETag, and version ID when available. The key must be under `BACKUP_S3_PREFIX/<replacement-target-id>/`, whose target id is the canonical connection identity from the leader's apply output (`target=...` in the `APPLY_SCHEMA=...` log line); consistent endpoint aliases matter. Check the selected backup log and bucket object against that identity. Restore **this new backup** into a separate empty drill database and validate its records with the read-only procedure in step 1, with no app/worker attached. A successfully uploaded backup of the original database cannot satisfy this check.

   Confirm a **new** backup-freshness verdict for the replacement, from the app's embedded runtime or the dedicated worker as selected; the job runs every six hours, so allow it to run and check its timestamp and target. A cached pre-cutover `/admin` result in Redis is not evidence. Verify the missed-backup alert now tracks the replacement schedule and confirm its next scheduled upload; a manual run alone does not prove recurring execution. For provider-only recovery, verify the replacement's backup/PITR policy and a new restorable recovery point instead of a logical object, and confirm the provider's alert. Record these results before declaring recovery complete.
6. **Resume deliberately and retain the original.** Reopen ingress and resume approved producers only after schema, runtime, data, and the replacement backup checks pass. Keep monitoring the first scheduled backup; if that check is still pending, record recovery as pending, not complete. Restore development's automatic deployments only after it is intentionally back on `main`/`master` with the leader `safe`; production stays manual on its pinned release. Remove temporary confirmations and unused restore/drill run configurations. Keep the original database and its existing backups intact through the owner's agreed recovery/retention window; retiring them is a separate explicit decision.

**Failure and rollback boundaries:** before the new runtime or integrations have written to the replacement or produced external effects, a failed handoff can leave the original deployment in place or return every consumer to the recorded original target and compatible release, following the same leader-first admission and backup checks. After the first new runtime starts, assume writes/jobs may have happened even while public traffic is blocked. Stop and reconcile those changes before any return to the original; switching URLs back would lose replacement writes and can repeat external effects. There is no automatic rollback or uninterrupted-traffic guarantee. A restore or apply whose outcome is uncertain follows [§ When an apply or restore outcome is uncertain](#when-an-apply-or-restore-outcome-is-uncertain), not a blind retry. Restart or retry only after its outcome is established; never leave old and replacement consumers active together.

### When an apply or restore outcome is uncertain

Ordinary schema apply executes its SQL and its schema receipt in one transaction on one locked PostgreSQL session, and the restore writer streams the archive through psql in one transaction. A crash, kill, or connection loss therefore leaves the effect either fully applied or fully rolled back — but a container exit alone does not tell you which, and cancelling a client never proves the server rolled back.

When an apply or restore was interrupted with an unknown outcome:

1. **Stop the original effect first.** Terminate the job/deployment that was running it and confirm no Prisma schema-engine or `pg_restore`/psql child of it can still run. Two overlapping effects are the one outcome this protocol cannot protect against once the original process is still alive.
2. **Establish the outcome with read-only queries.** Never re-run the effect to "see what happens". For an apply, connect an inspection client and check `starter_control.schema_releases` (which fingerprint/`applied_at` is recorded) plus the specific objects the plan would have created or dropped. For a restore, check the destination's catalogs and row counts against the expected dump.
3. **Retry only from a verified state.** An apply retry is always safe once the outcome is known: it replans from the live database, and an already-applied plan shows up as an empty diff that refreshes the receipt. A restore retry must target a fresh empty destination (or an in-place destination you have verified is still replaceable), with a fresh preview and confirmation — never a blind re-run over a partially observed destination.

If the database cannot be reached at all, keep every writer stopped until it can be; do not assume the outcome was a rollback.

## Bucket retention, versioning, and incomplete uploads

The dump key has a UUID and the writer sends an unconditional-create condition;
it never deletes an off-site copy. That is safety, not retention: without a
bucket lifecycle, old dumps and failed multipart parts accumulate cost forever.
Choose and record these owner decisions in `notes/03-hosting.md` before relying
on logical backups:

1. **Retention window.** Keep enough daily dumps to cover the longest time you
   expect a bad deploy or unnoticed data loss to survive. A short window costs
   less but narrows recovery; a longer one costs more storage and request fees.
   Apply the bucket's prefix-scoped lifecycle expiration to backup objects, not
   a script that deletes them.
2. **Versioning — enable it by default.** The dump-writer key holds PutObject,
   so on an unversioned bucket anything holding that key — a compromised
   server, a confused script — can silently overwrite the newest dump with
   junk. Versioning keeps the previous version of an overwritten object, lets a
   restore pin an exact `RESTORE_BACKUP_S3_VERSION_ID`, and makes the recorded
   drill version IDs meaningful. Old versions accumulate until their own
   lifecycle rule expires them, so set a noncurrent-version expiration
   alongside the retention window. Run without versioning only when an owner
   has explicitly accepted that the dump-writer key can irrecoverably replace
   every dump.
3. **Incomplete multipart uploads.** Add a lifecycle abort rule. The writer
   attempts an explicit abort on a caught upload failure, but a killed process,
   network partition, or provider outage can leave parts behind. A 7-day abort
   window is a practical starting point; shorter reduces cost sooner, while
   longer gives transient provider incidents more time to resolve.
4. **Object Lock is optional and irreversible.** It can make retained dumps
   tamper-resistant, but can also prevent deletion during an incident and may
   have compliance/cost consequences. Do not enable it until an owner has
   chosen retention and legal requirements; this template does not select it.

The existing conditional `PutObject` path remains in use through 5 GB
(5,000,000,000 bytes, deliberately below a 5 GiB-only provider maximum). For a
larger multipart backup, the endpoint must support `CreateMultipartUpload`,
`UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`, and
`If-None-Match: *` on completion. AWS S3 documents this conditional completion
request; the template's S3-compatible endpoint examples (R2, B2, MinIO, and
Spaces) are **not** a conformance claim for that exact condition. Do not rely
on a dump above 5,000,000,000 bytes at one of those endpoints until a
controlled provider test proves that it rejects an existing key with the
condition present. A
provider silently accepting an unknown header is not proof of no-overwrite
enforcement.

The writer uses at most 10,000 sequential 512 MiB ranges (bounded stream
memory and application-owned retries that reopen each range); it fails rather
than dropping the condition when an endpoint explicitly rejects conditional
completion. SDK mocks prove the control flow, not an external provider's
conditional-write semantics. If a completion response is lost, the object
might have completed while the writer cannot safely record its ETag/version
identity; the run fails, sends no heartbeat, and the freshness check—not an
automatic retry—decides the next operator action. The uploader attempts an
explicit abort only after a caught upload-operation failure with a known upload
ID. It has no process-signal handler. When a catchable signal is delivered to
the artifact-owning applier, `backup.sh` drains its current direct writer before
the applier removes the private local directory; no later backup stage is
started after that signal. Private cancellation channels avoid signalling a
recycled shell PID. If a supervisor or nested owner dies without acknowledging
its drain, the applier retains dependent local artifacts and refuses success.
SIGKILL cannot run that owner's cleanup; channel EOF requests cancellation
from a surviving supervisor, but cannot establish a server or upload outcome.
The lifecycle abort rule therefore remains required.
The same rule covers a lost response to multipart creation: without an upload
ID the writer cannot prove which upload to abort, so it does not retry
initiation blindly.

## Before destructive schema deploys

Before `APPLY_SCHEMA=dangerous`:

1. Confirm expand-contract contract phase.
2. Preview SQL with `prisma migrate diff` ([schema-push.md](./schema-push.md#previewing-the-diff-before-a-destructive-deploy)).
3. Confirm a recent backup exists (logical or provider, per your profile).
4. Confirm restore has been practiced.

**When logical backups are enabled** (`BACKUP_ENABLED=true` and `BACKUP_PRE_APPLY_ENABLED=true`): a **successful pre-apply pg_dump upload is required** in the same deploy before the confirm-bound hashed SQL runs. The entrypoint fatals if the dump or upload fails.

**Provider-only profile** (`BACKUP_ENABLED=false` or `BACKUP_PRE_APPLY_ENABLED=false`): set `APPLY_SCHEMA_ACCEPT_PROVIDER_BACKUP=I_ACCEPT_PROVIDER_BACKUP_ONLY` for that deploy only, after confirming provider snapshot/PITR covers rollback. Unset it when the deploy completes.

## Other platforms

The walkthrough above is Dokploy-specific; the contract underneath it is not. Anywhere else, the same three things hold: the db-applier image's mode comes from its command or `DB_APPLIER_MODE`, every backup and restore is driven entirely by environment variables set on that one container, and the identity split (dump-writer vs. ListBucket monitor) is enforced by the scripts regardless of who sets the variables. If the host can launch a one-shot container on a timer, use the external-cron profile; if it cannot, use the in-container `schedule` service exactly as Dokploy does.
