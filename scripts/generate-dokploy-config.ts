/** Generate a reviewable native-Git setup. No network, credentials, or writes. */
import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serverVars } from "../packages/env/src/vars/server.js";
import { sharedVars } from "../packages/env/src/vars/shared.js";
import { ENV_VARS } from "./lib/env-manifest.js";

type Topology = "app" | "app-applier" | "app-worker" | "full";
type Options = {
  environment: "development" | "production";
  gitRef: string;
  topology: Topology;
  url: string;
};
const keys = new Set(ENV_VARS.map((variable) => variable.key));
const sharedKeys = new Set(Object.keys(sharedVars));
const serverKeys = new Set([...sharedKeys, ...Object.keys(serverVars)]);

export function generateDokployConfig(options: Options) {
  if (!["development", "production"].includes(options.environment))
    throw new Error("Choose development or production.");
  if (!["app", "app-applier", "app-worker", "full"].includes(options.topology))
    throw new Error("Choose app, app-applier, app-worker, or full.");
  if (options.environment === "development" && !["main", "master"].includes(options.gitRef))
    throw new Error("Development automatic deployment follows main or master.");
  if (options.environment === "production" && !/^release\/[a-f0-9]{40}$/.test(options.gitRef))
    throw new Error("Production requires an immutable release/<full-commit-sha> Git tag.");
  const url = new URL(options.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("URL must be an HTTPS origin without credentials, query, or path.");
  const applier = ["app-applier", "full"].includes(options.topology);
  const worker = ["app-worker", "full"].includes(options.topology);
  const reference = (key: string) => {
    if (!keys.has(key)) throw new Error(`Environment manifest is missing ${key}.`);
    return `\${{environment.${key}}}`;
  };
  const refs = (names: string[]) =>
    Object.fromEntries(names.map((name) => [name, reference(name)]));
  const runtime = refs(["DATABASE_URL", "REDIS_URL"]);
  const serverEnvironment = {
    ...runtime,
    ...refs([
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "ADMIN_EMAILS",
      "SMTP_HOST",
      "SMTP_PORT",
      "SMTP_USER",
      "SMTP_PASS",
      "SMTP_FROM",
    ]),
    NODE_ENV: "production",
    WORKER_MODE: worker ? "external" : "embedded",
    APPLY_SCHEMA: applier ? "off" : "safe",
    WAIT_FOR_SCHEMA: applier ? "true" : "false",
  };
  const workerEnvironment = {
    ...runtime,
    NODE_ENV: "production",
    APPLY_SCHEMA: "off",
    WAIT_FOR_SCHEMA: "true",
  };
  const application = (role: string, dockerfile: string, environment: Record<string, string>) => ({
    name: `${options.environment}-${role}`,
    sourceType: "git",
    customGitUrl: "<your repository URL; configure its Git credentials in Dokploy>",
    customGitBranch: options.gitRef,
    autoDeploy: options.environment === "development",
    buildType: "dockerfile",
    dockerfile,
    dockerContextPath: ".",
    createEnvFile: false,
    modeSwarm: { Replicated: { Replicas: 1 } },
    restartPolicySwarm: { Condition: role === "schema-apply" ? "none" : "on-failure" },
    // Dokploy defaults to these when unset. A partial saved object replaces
    // those defaults, so the checklist spells out the complete runtime policy.
    updateConfigSwarm: { Parallelism: 1, Order: "start-first", FailureAction: "rollback" },
    rollbackConfigSwarm: { Parallelism: 1, Order: "start-first" },
    stopGracePeriodSwarm: 30_000_000_000,
    environment,
    domain: role === "server" ? { host: url.hostname, port: 3000, https: true } : null,
  });
  const applications = [application("server", "Dockerfile", serverEnvironment)];
  if (worker) applications.push(application("worker", "Dockerfile.worker", workerEnvironment));
  if (applier)
    applications.unshift(
      application("schema-apply", "Dockerfile.db-applier", {
        ...refs(["DATABASE_URL"]),
        DB_APPLIER_MODE: "apply",
        APPLY_SCHEMA: "safe",
      }),
    );
  const required = [
    ...new Set(
      applications.flatMap((app) =>
        Object.values(app.environment).flatMap((value) => {
          const match = /^\$\{\{environment\.([A-Z0-9_]+)\}\}$/.exec(value);
          return match ? [match[1]!] : [];
        }),
      ),
    ),
  ];
  // Derive optional runtime inventory from the declarations + manifest. An
  // optional credential is never granted to every role just because it exists.
  const excluded =
    /^(RESTORE_|APPLY_SCHEMA|DB_APPLIER_MODE|WAIT_FOR_SCHEMA|WORKER_MODE|BACKUP_S3_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)$)/;
  const optionalFor = (allowed: Set<string>, mapped: Record<string, string>) =>
    ENV_VARS.filter(
      (variable) =>
        allowed.has(variable.key) &&
        !Object.hasOwn(mapped, variable.key) &&
        !excluded.test(variable.key),
    ).map((variable) => variable.key);
  return {
    format: "Dokploy settings checklist; not an import or API payload",
    environment: options.environment,
    topology: options.topology,
    compose: composeChecklist(),
    database: { name: `${options.environment}-postgres`, sharedWithOtherEnvironments: false },
    redis: {
      name: `${options.environment}-redis`,
      sharedWithOtherEnvironments: false,
      maxmemoryPolicy: "noeviction",
    },
    environmentVariablesToSetOnce: Object.fromEntries(
      required.map((key) => [
        key,
        key === "BETTER_AUTH_URL"
          ? url.origin
          : `<set ${key} for ${options.environment}; complete literal value, no nested references>`,
      ]),
    ),
    applications,
    optionalEnvironmentKeys: {
      server: optionalFor(serverKeys, serverEnvironment),
      ...(worker ? { worker: optionalFor(sharedKeys, workerEnvironment) } : {}),
    },
    backupSetupRequired:
      "Configure one off-site backup schedule and external missed-backup alert before relying on this environment. Give dump-writer keys only to the schema leader/backup service; give freshness-monitor keys only to the selected worker runtime. Follow patterns/backup-and-restore.md.",
    rolloutContract:
      "Start-first is a Swarm task ordering policy, not a cross-Application completion gate or a promise of uninterrupted traffic. Docker server health checks /health; deployment acceptance also requires /ready and successful selected applier completion. An old schema fingerprint cannot restart after the receipt advances, even if its code tolerates the new schema. Roll forward or apply a reviewed correction through the leader.",
    releaseContract:
      options.environment === "development"
        ? "Git builds may finish in any order. Followers wait for a successful matching schema receipt and live schema check. Queue payload changes must stay compatible across adjacent commits."
        : "Disable automatic deployment. Create the immutable Git tag before selecting it, use this same tag for every role, deploy the schema leader first, then runtimes, and run the deployment verifier.",
  };
}

// ---------------------------------------------------------------------------
// Dokploy-consumable Compose (the blessed topology)
//
// Dokploy deploys Compose files directly, so the generator also emits
// docker-compose.dokploy.yml: server (embedded jobs) + one-shot db-applier
// schema leader + postgres:17 + redis:7 (noeviction). Unlike the JSON
// checklist above — which describes manual-UI native-Git Applications for all
// four topologies — the Compose is ALWAYS the blessed app-applier shape; the
// other topologies stay manual-UI/advanced (infra-notes.md § Advanced
// topologies). Env values use compose `${VAR:-}` interpolation so Dokploy's
// per-service environment fills them; secrets get an EMPTY default only, never
// a value. The same tables below drive the per-service checklist in the JSON
// output, so the file and the checklist cannot drift.
// ---------------------------------------------------------------------------

/** A compose `${NAME:-fallback}` interpolation, built so linters see no raw `${`. */
const composeVar = (name: string, fallback = "") => `\${${name}:-${fallback}}`;

const databaseUrl = `postgresql://\${POSTGRES_USER:-starter}:\${POSTGRES_PASSWORD:-}@postgres:5432/\${POSTGRES_DB:-starter}`;
const redisUrl = `redis://:\${REDIS_PASSWORD:-}@redis:6379`;

/** Service env blocks for the compose, in emission order. */
const composeEnvironment: Record<string, Record<string, string>> = {
  postgres: {
    POSTGRES_USER: composeVar("POSTGRES_USER", "starter"),
    POSTGRES_PASSWORD: composeVar("POSTGRES_PASSWORD"),
    POSTGRES_DB: composeVar("POSTGRES_DB", "starter"),
  },
  redis: {
    REDIS_PASSWORD: composeVar("REDIS_PASSWORD"),
  },
  "schema-apply": {
    DATABASE_URL: databaseUrl,
    APPLY_SCHEMA: "safe",
  },
  server: {
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    BETTER_AUTH_SECRET: composeVar("BETTER_AUTH_SECRET"),
    ADMIN_EMAILS: composeVar("ADMIN_EMAILS"),
    SMTP_HOST: composeVar("SMTP_HOST"),
    SMTP_PORT: composeVar("SMTP_PORT", "587"),
    SMTP_USER: composeVar("SMTP_USER"),
    SMTP_PASS: composeVar("SMTP_PASS"),
    SMTP_FROM: composeVar("SMTP_FROM"),
    NODE_ENV: "production",
    WORKER_MODE: "embedded",
    // Quoted: bare off/true are YAML booleans, and this value must stay a string.
    APPLY_SCHEMA: '"off"',
    WAIT_FOR_SCHEMA: '"true"',
  },
};

/** Variables a service needs with no default at all: `${NAME:-}` tokens only. */
function composeRequiredVariables(service: string): string[] {
  const environment = composeEnvironment[service] ?? {};
  return [
    ...new Set(
      Object.values(environment).flatMap((value) =>
        [...value.matchAll(/\$\{([A-Z0-9_]+):-\}/g)].map((match) => match[1] ?? ""),
      ),
    ),
  ].sort();
}

/**
 * The checklist's compose section — which file to import and which variables
 * each service still needs from Dokploy's environment UI.
 */
function composeChecklist(): {
  file: string;
  topology: string;
  import: string;
  note: string;
  environmentVariables: Record<string, string[]>;
  manualSchemaRerun: string;
  backups: string;
} {
  return {
    file: "docker-compose.dokploy.yml",
    topology:
      "app-applier (blessed): server with embedded jobs + one-shot db-applier schema leader + postgres:17 + redis:7 (noeviction)",
    import:
      "Dokploy → Projects → your project → Compose → paste the generated file, then set the variables below to complete literal values (no nested references).",
    note: "The compose is always the blessed app-applier shape regardless of --topology; the topology flag above selects the manual-UI Applications checklist only.",
    environmentVariables: Object.fromEntries(
      Object.keys(composeEnvironment).map((service) => [
        service,
        composeRequiredVariables(service),
      ]),
    ),
    manualSchemaRerun:
      "docker compose run --rm schema-apply — re-publishes the schema receipt out-of-band (APPLY_SCHEMA=safe is already set on the service).",
    backups:
      "db-backup ships commented out in the compose — uncomment it and fill the BACKUP_S3_* dump-writer values (§ 11 of patterns/deployment-vps.md), or use Dokploy's managed-backup UI instead. Exactly one schedule per database.",
  };
}

/**
 * Render docker-compose.dokploy.yml for the blessed topology. Pure: builds the
 * YAML text from the env tables plus the validated options (the HTTPS origin is
 * baked into BETTER_AUTH_URL and the Traefik Host rule; everything else is
 * `${VAR:-}` interpolation Dokploy resolves per service).
 */
export function generateDokployCompose(options: Options): string {
  const url = new URL(options.url);
  const router = `${options.environment}-server`;
  const label = (value: string) => `      - "${value}"`;
  const envLines = (entries: Record<string, string>) =>
    Object.entries(entries).map(([key, value]) => `      ${key}: ${value}`);
  return `# docker-compose.dokploy.yml — GENERATED FILE. Do not edit or commit.
#
# Produced by:
#   pnpm dokploy:config --environment ${options.environment} --git-ref ${options.gitRef} --url ${options.url}
#
# The blessed Dokploy topology (infra-notes.md § Picking the schema leader):
#   server        — Hono API + SPA + SSR; background jobs EMBEDDED (WORKER_MODE=embedded)
#   schema-apply  — one-shot db-applier schema leader: APPLY_SCHEMA=safe runs on every
#                   deploy that recreates it (restart "no" keeps a successful exit terminal)
#   postgres      — PostgreSQL 17 (hard floor: schema apply uses PG17 server features)
#   redis         — Redis 7, AOF persistence, maxmemory-policy noeviction (BullMQ requires
#                   noeviction; eviction can lose or corrupt queued jobs)
#
# Import: Dokploy → Projects → your project → Compose → New Compose → paste this file,
# then fill the env vars the JSON checklist lists under \`compose.environmentVariables\`
# (complete literal values — secrets have NO defaults in this file). Dokploy rebuilds
# these images from the connected repository/branch on every deploy.
#
# Prefer Dokploy's managed Postgres/Redis (see § 4 and § 5 of patterns/deployment-vps.md)?
# Delete the postgres and redis services and the volumes below, and set DATABASE_URL / REDIS_URL
# directly on server + schema-apply using the internal hostnames Dokploy shows you.
#
# Traefik routing, TLS, response compression (patterns/deployment-vps.md § Enable response
# compression (don't skip)) and the swarm update/rollback/stop-grace policy are pre-wired.
# The \`dokploy\` external network is created by Dokploy; remove it (and the server
# \`networks:\` block) when running this file with plain docker compose.

name: ${options.environment}

services:
  postgres:
    image: postgres:17
    restart: unless-stopped
    environment:
${envLines(composeEnvironment.postgres ?? {}).join("\n")}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      # $$ escapes compose interpolation — the values come from this service's own env.
      test: pg_isready -U $\${POSTGRES_USER} -d $\${POSTGRES_DB}
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s
    # No ports published: postgres stays on the internal compose network. If you need
    # host access, bind loopback ONLY ("127.0.0.1:5432:5432") — a bare "5432:5432"
    # binds 0.0.0.0 and Docker's iptables rules bypass host firewalls (see
    # docker-compose.dev.yml for the full warning).

  redis:
    image: redis:7
    restart: unless-stopped
    # An empty REDIS_PASSWORD disables auth (same as docker-compose.dev.yml); set one
    # and it is enforced here and carried by the server's REDIS_URL.
    command: ["redis-server", "--appendonly", "yes", "--maxmemory-policy", "noeviction", "--requirepass", "\${REDIS_PASSWORD:-}"]
    environment:
${envLines(composeEnvironment.redis ?? {}).join("\n")}
    volumes:
      - redis-data:/data
    healthcheck:
      test: redis-cli --no-auth-warning -a "$\${REDIS_PASSWORD}" ping
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s
    # No ports published — see the postgres note above.

  # One-shot schema leader (the blessed app-applier topology). Manual receipt refresh:
  #   docker compose run --rm schema-apply
  # Destructive changes keep the two-step confirmation flow — patterns/deployment-vps.md
  # § Schema deploy lifecycle.
  schema-apply:
    build:
      context: .
      dockerfile: Dockerfile.db-applier
    command: apply
    restart: "no"
    depends_on:
      postgres:
        condition: service_healthy
    environment:
${envLines(composeEnvironment["schema-apply"] ?? {}).join("\n")}
      # Pre-apply logical backups arm the pg_dump gate when BACKUP_S3_* is configured.
      # Give this service the DUMP-WRITER pair only — never the app secrets.
      # BACKUP_S3_BUCKET: \${BACKUP_S3_BUCKET:-}
      # BACKUP_S3_ACCESS_KEY_ID: \${BACKUP_S3_ACCESS_KEY_ID:-}
      # BACKUP_S3_SECRET_ACCESS_KEY: \${BACKUP_S3_SECRET_ACCESS_KEY:-}
      # BACKUP_S3_REGION: \${BACKUP_S3_REGION:-auto}
      # BACKUP_S3_ENDPOINT: \${BACKUP_S3_ENDPOINT:-}
    deploy:
      replicas: 1
      restart_policy:
        condition: none

  server:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        # Full commit SHA of the deployed ref (§ 7 Build-time vs runtime env vars).
        BUILD_VERSION: \${BUILD_VERSION:-}
    restart: unless-stopped
    # The server holds /ready at 503 for 5s, then drains in-flight requests for up to
    # 10s more — the default 10s grace SIGKILLs it mid-drain. The image HEALTHCHECK
    # (/health, 480s start period) already covers the schema wait; do not override it.
    stop_grace_period: 30s
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      # Defense in depth: the server also runs WAIT_FOR_SCHEMA=true, so its entrypoint
      # refuses to boot until the schema receipt matches its image.
      schema-apply:
        condition: service_completed_successfully
    environment:
${envLines(composeEnvironment.server ?? {}).join("\n")}
      BETTER_AUTH_URL: ${url.origin}
    labels:
${[
  "traefik.enable=true",
  `traefik.http.routers.${router}.rule=Host(\`${url.hostname}\`)`,
  `traefik.http.routers.${router}.entrypoints=websecure`,
  `traefik.http.routers.${router}.tls.certresolver=letsencrypt`,
  `traefik.http.services.${router}.loadbalancer.server.port=3000`,
  `traefik.http.middlewares.${router}-compress.compress=true`,
  `traefik.http.middlewares.${router}-compress.compress.encodings=zstd,br,gzip`,
  `traefik.http.routers.${router}.middlewares=${router}-compress`,
]
  .map(label)
  .join("\n")}
    networks:
      - default
      - dokploy
    deploy:
      replicas: 1
      update_config:
        parallelism: 1
        order: start-first
        failure_action: rollback
      rollback_config:
        parallelism: 1
        order: start-first
      restart_policy:
        condition: on-failure

  # Nightly logical backup — the default Dokploy backup profile (§ 11). Uncomment and
  # fill the dump-writer values, then deploy. Dump-writer keys only; the optional
  # non-secret S3_ACCESS_KEY_ID comparison input rejects app-key reuse. Schedule
  # mirrors BACKUP_CRON (5 fields, no seconds).
  # db-backup:
  #   build:
  #     context: .
  #     dockerfile: Dockerfile.db-applier
  #   restart: unless-stopped
  #   depends_on:
  #     postgres:
  #       condition: service_healthy
  #   environment:
  #     DB_APPLIER_MODE: schedule
  #     BACKUP_CRON: "0 3 * * *"
  #     DATABASE_URL: ${databaseUrl}
  #     BACKUP_S3_BUCKET: \${BACKUP_S3_BUCKET:-}
  #     BACKUP_S3_ACCESS_KEY_ID: \${BACKUP_S3_ACCESS_KEY_ID:-}
  #     BACKUP_S3_SECRET_ACCESS_KEY: \${BACKUP_S3_SECRET_ACCESS_KEY:-}
  #     BACKUP_S3_REGION: \${BACKUP_S3_REGION:-auto}
  #     BACKUP_S3_ENDPOINT: \${BACKUP_S3_ENDPOINT:-}
  #     S3_ACCESS_KEY_ID: \${S3_ACCESS_KEY_ID:-}

volumes:
  postgres-data:
  redis-data:

networks:
  dokploy:
    name: dokploy-network
    external: true
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const fields: Record<string, string> = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      const value = args[index + 1];
      if (
        !key ||
        !["--environment", "--git-ref", "--topology", "--url"].includes(key) ||
        fields[key] ||
        !value ||
        value.startsWith("--")
      )
        throw new Error(
          "Use --environment development|production --git-ref <ref> --topology app|app-applier|app-worker|full --url <https-origin>.",
        );
      fields[key] = value;
    }
    const options = {
      environment: fields["--environment"],
      gitRef: fields["--git-ref"],
      topology: fields["--topology"] || "app-applier",
      url: fields["--url"],
    };
    if (!options.environment || !options.gitRef || !options.url)
      throw new Error("--environment, --git-ref, and --url are required.");
    const composePath = fileURLToPath(new URL("../docker-compose.dokploy.yml", import.meta.url));
    writeFileSync(composePath, generateDokployCompose(options as Options));
    console.error(
      `[dokploy] wrote ${relative(process.cwd(), composePath)} — a gitignored artifact. Import it in Dokploy (Compose) and fill the variables the checklist lists under "compose".`,
    );
    console.log(JSON.stringify(generateDokployConfig(options as Options), null, 2));
  } catch (error) {
    console.error(
      error instanceof TypeError
        ? "Invalid configuration URL."
        : error instanceof Error
          ? error.message
          : "Invalid configuration.",
    );
    process.exitCode = 1;
  }
}
