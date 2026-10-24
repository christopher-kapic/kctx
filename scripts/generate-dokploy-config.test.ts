import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { generateDokployCompose, generateDokployConfig } from "./generate-dokploy-config.js";

const defaults = {
  environment: "development" as const,
  gitRef: "main",
  topology: "app-applier" as const,
  url: "https://dev.example.com",
};

test("default native Git setup waits for applier, follows main, and has flat explicit env references", () => {
  const config = generateDokployConfig(defaults);
  assert.deepEqual(
    config.applications.map((app) => app.name),
    ["development-schema-apply", "development-server"],
  );
  assert.equal(config.applications[0]?.restartPolicySwarm.Condition, "none");
  assert.equal(config.applications[1]?.environment.WAIT_FOR_SCHEMA, "true");
  assert.equal(config.applications[1]?.environment.WORKER_MODE, "embedded");
  for (const app of config.applications) {
    assert.equal(app.sourceType, "git");
    assert.equal(app.autoDeploy, true);
    assert.equal(app.customGitBranch, "main");
    assert.deepEqual(app.updateConfigSwarm, {
      Parallelism: 1,
      Order: "start-first",
      FailureAction: "rollback",
    });
    assert.deepEqual(app.rollbackConfigSwarm, { Parallelism: 1, Order: "start-first" });
  }
  for (const value of Object.values(config.environmentVariablesToSetOnce))
    assert.ok(!value.includes("${{"));
  assert.equal(config.applications[0]?.environment.BETTER_AUTH_SECRET, undefined);
  assert.equal(JSON.stringify(config).includes("APPLY_SCHEMA_CONFIRM"), false);
});

test("all four topologies select one schema leader and retain background execution", () => {
  for (const topology of ["app", "app-applier", "app-worker", "full"] as const) {
    const config = generateDokployConfig({ ...defaults, topology });
    assert.ok(
      config.applications.every(
        (app) =>
          app.updateConfigSwarm.Order === "start-first" &&
          app.updateConfigSwarm.FailureAction === "rollback" &&
          app.rollbackConfigSwarm.Order === "start-first",
      ),
    );
    assert.match(config.rolloutContract, /old schema fingerprint cannot restart/);
    assert.equal(
      config.applications.filter((app) => app.environment.APPLY_SCHEMA === "safe").length,
      1,
    );
    const server = config.applications.find((app) => app.name.endsWith("-server"));
    assert.equal(
      server?.environment.WORKER_MODE,
      topology.includes("worker") || topology === "full" ? "external" : "embedded",
    );
    for (const follower of config.applications.filter(
      (app) => app.environment.APPLY_SCHEMA === "off",
    ))
      assert.equal(follower.environment.WAIT_FOR_SCHEMA, "true");
  }
});

// This checks the operator runbook against the generated settings. It does not
// simulate Dokploy changing references, draining jobs, or performing a cutover.
test("replacement recovery documents the generated leader and followers for all four topologies", () => {
  const guide = readFileSync(new URL("../patterns/backup-and-restore.md", import.meta.url), "utf8");
  const handoff = guide.split("### Replacement database recovery handoff\n")[1]?.split("### ")[0];
  assert.ok(handoff, "Replacement recovery needs one canonical handoff.");
  for (const [topology, label] of [
    ["app", "App"],
    ["app-applier", "App + applier"],
    ["app-worker", "App + worker"],
    ["full", "App + applier + worker"],
  ] as const) {
    const config = generateDokployConfig({ ...defaults, topology });
    const leader = config.applications.find((app) => app.environment.APPLY_SCHEMA === "safe");
    assert.ok(leader);
    const row: string | undefined = handoff
      .split("\n")
      .find((line) => line.startsWith(`   | ${label} |`));
    assert.ok(row, `Missing recovery row for ${topology}`);
    const [, , first, after]: string[] = row.split("|");
    assert.ok(first && after);
    assert.match(first, /APPLY_SCHEMA=safe/);
    if (leader.dockerfile === "Dockerfile.db-applier") {
      assert.match(first, /Applier: command `apply`/);
      assert.match(first, /this task's exit 0/);
    } else {
      assert.match(first, /App entrypoint/);
      assert.match(first, /WAIT_FOR_SCHEMA=false/);
    }
    const server = config.applications.find((app) => app.name.endsWith("-server"));
    assert.ok(row.includes(`WORKER_MODE=${server?.environment.WORKER_MODE}`));
    const followers = config.applications.filter((app) => app.environment.APPLY_SCHEMA === "off");
    if (followers.length) {
      assert.match(after, /APPLY_SCHEMA=off/);
      assert.match(after, /WAIT_FOR_SCHEMA=true/);
    }
  }
  for (const consumer of [
    "App, including embedded background jobs",
    "Dedicated worker",
    "Separate schema applier",
    "`db-backup` schedule service, or an external backup runner",
    "Backup freshness and external monitoring",
    "Provider/managed backup policy and other direct DB clients",
  ])
    assert.ok(handoff.includes(`| ${consumer}`), `Missing recovery consumer: ${consumer}`);
  assert.match(handoff, /redeploy each affected Application\/job using the new configuration/);
  assert.match(handoff, /BEGIN READ ONLY;/);
  assert.match(handoff, /Restore \*\*this new backup\*\* into a separate empty drill database/);
  assert.match(
    handoff,
    /After the first new runtime starts, assume writes\/jobs may have happened/,
  );
});

test("production is manually triggered, uses one immutable ref, and has separate database/auth values", () => {
  assert.throws(
    () => generateDokployConfig({ ...defaults, environment: "production" }),
    /immutable/,
  );
  const config = generateDokployConfig({
    ...defaults,
    environment: "production",
    gitRef: `release/${"a".repeat(40)}`,
    topology: "full",
    url: "https://example.com",
  });
  for (const app of config.applications) assert.equal(app.autoDeploy, false);
  assert.equal(new Set(config.applications.map((app) => app.customGitBranch)).size, 1);
  assert.equal(config.database.name, "production-postgres");
  assert.equal(config.redis.name, "production-redis");
  assert.equal(config.environmentVariablesToSetOnce.BETTER_AUTH_URL, "https://example.com");
  assert.match(config.environmentVariablesToSetOnce.BETTER_AUTH_SECRET ?? "", /production/);
});

test("each role retains its optional capabilities even when a sibling maps the same key", () => {
  for (const topology of ["app", "app-applier", "app-worker", "full"] as const) {
    const config = generateDokployConfig({ ...defaults, topology });
    const server = config.applications.find((app) => app.name.endsWith("-server"))!;
    for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"]) {
      assert.equal(server.environment[key], `\${{environment.${key}}}`);
      assert.equal(config.optionalEnvironmentKeys.server.includes(key), false);
      if (config.optionalEnvironmentKeys.worker)
        assert.ok(
          config.optionalEnvironmentKeys.worker.includes(key),
          `${topology}: worker needs ${key}`,
        );
    }
    for (const optional of Object.values(config.optionalEnvironmentKeys)) {
      for (const key of [
        "S3_BUCKET",
        "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY",
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
        "BACKUP_MONITOR_S3_ACCESS_KEY_ID",
        "BACKUP_MONITOR_S3_SECRET_ACCESS_KEY",
        "SCHEMA_WAIT_TIMEOUT_SECONDS",
      ])
        assert.ok(optional.includes(key), `${topology}: missing capability ${key}`);
      assert.equal(
        optional.some((key) => /^(RESTORE_|APPLY_SCHEMA_CONFIRM)/.test(key)),
        false,
      );
      assert.equal(optional.includes("BACKUP_S3_SECRET_ACCESS_KEY"), false);
      assert.equal(optional.includes("NODE_ENV"), false);
    }
    assert.equal(
      config.optionalEnvironmentKeys.worker?.includes("BETTER_AUTH_SECRET") ?? false,
      false,
    );
  }
});

test("generated compose emits the blessed topology with one leader, policies, and labels", () => {
  const compose = generateDokployCompose(defaults);
  // No tabs; service blocks sit at a stable two-space indent (structural stand-in
  // for a YAML parse — js-yaml is not a direct dependency and none is added).
  assert.ok(!compose.includes("\t"), "compose must use spaces only");
  for (const service of ["postgres:", "redis:", "schema-apply:", "server:"])
    assert.match(compose, new RegExp(`^  ${service}$`, "m"), `missing service ${service}`);
  assert.doesNotMatch(compose, /^ {2}worker:$/m, "blessed topology embeds jobs; no worker service");

  assert.match(compose, /image: postgres:17/);
  assert.match(compose, /image: redis:7/);
  assert.match(compose, /--maxmemory-policy", "noeviction"/);
  assert.match(compose, /postgres-data:/);
  assert.match(compose, /redis-data:/);

  // Exactly one schema leader, one-shot, with the app gated behind it.
  assert.match(compose, /^ {6}APPLY_SCHEMA: safe$/m);
  assert.match(compose, /^ {6}APPLY_SCHEMA: "off"$/m);
  assert.match(compose, /^ {6}WAIT_FOR_SCHEMA: "true"$/m);
  assert.match(compose, /^ {6}WORKER_MODE: embedded$/m);
  assert.match(compose, /^ {4}command: apply$/m);
  assert.match(compose, /^ {4}restart: "no"$/m);
  assert.match(compose, /condition: none/);
  assert.match(compose, /condition: service_completed_successfully/);
  assert.match(compose, /condition: service_healthy/);

  // Healthchecks that match the images' expectations; the app's own
  // HEALTHCHECK (/health, 480s start period) is not overridden.
  assert.match(compose, /pg_isready -U \$\$\{POSTGRES_USER\}/);
  assert.match(compose, /redis-cli --no-auth-warning -a "\$\$\{REDIS_PASSWORD\}" ping/);
  assert.doesNotMatch(compose, /^ {4}server:[\s\S]*?^ {4}healthcheck:/m);

  // Traefik routing + the compression middleware from dokploy:verify expectations,
  // with the validated host baked in.
  const router = "development-server";
  assert.ok(
    compose.includes(`traefik.http.routers.${router}.rule=Host(\`dev.example.com\`)`),
    "Traefik Host rule must bake the validated origin",
  );
  assert.match(
    compose,
    new RegExp(`traefik\\.http\\.services\\.${router}\\.loadbalancer\\.server\\.port=3000`),
  );
  assert.match(
    compose,
    new RegExp(`traefik\\.http\\.middlewares\\.${router}-compress\\.compress=true`),
  );
  assert.match(compose, /compress\.encodings=zstd,br,gzip/);
  assert.match(
    compose,
    new RegExp(`traefik\\.http\\.routers\\.${router}\\.middlewares=${router}-compress`),
  );

  // The swarm update/rollback/stop-grace policy the checklist used to tell
  // users to hand-configure.
  assert.match(compose, /order: start-first/);
  assert.match(compose, /failure_action: rollback/);
  assert.match(compose, /^ {4}stop_grace_period: 30s$/m);

  // No host ports anywhere — DB and Redis never bind 0.0.0.0 (or anything).
  assert.doesNotMatch(compose, /^ {4}ports:/m);
  assert.match(compose, /127\.0\.0\.1:5432:5432/);

  // Backups ship as the documented opt-in: the db-backup service stays inert.
  assert.match(compose, /^ {2}# db-backup:/m);

  // Production bakes its own host and router names.
  const production = generateDokployCompose({
    ...defaults,
    environment: "production",
    gitRef: `release/${"a".repeat(40)}`,
    url: "https://example.com",
  });
  assert.match(production, /production-server\.rule=Host\(`example\.com`\)/);
  assert.match(production, /BETTER_AUTH_URL: https:\/\/example\.com/);
});

test("generated compose interpolates every value and bakes no secret defaults", () => {
  const compose = generateDokployCompose(defaults);
  // Secrets appear only as empty-default interpolations.
  for (const key of [
    "BETTER_AUTH_SECRET",
    "POSTGRES_PASSWORD",
    "REDIS_PASSWORD",
    "SMTP_PASS",
    "SMTP_USER",
    "SMTP_FROM",
    "SMTP_HOST",
    "ADMIN_EMAILS",
  ])
    assert.match(
      compose,
      new RegExp(`^\\s+[A-Z_]*:?\\s*.*\\$\\{${key}:-\\}`, "m"),
      `${key} missing`,
    );
  // No non-empty default behind any secret-shaped interpolation.
  for (const match of compose.matchAll(
    /\$\{([A-Z0-9_]*(?:SECRET|PASSWORD|PASS)[A-Z0-9_]*):-([^}]*)\}/g,
  )) {
    assert.equal(match[2], "", `${match[1]} must not carry a default value`);
  }
  // Non-secret conveniences keep their defaults.
  assert.match(compose, /\$\{POSTGRES_USER:-starter\}/);
  assert.match(compose, /\$\{POSTGRES_DB:-starter\}/);
  assert.match(compose, /\$\{SMTP_PORT:-587\}/);
  // No confirmation keys anywhere — those are per-deploy dashboard values.
  assert.ok(!compose.includes("APPLY_SCHEMA_CONFIRM"));
  assert.ok(!compose.includes("RESTORE_"));
});

test("checklist describes the compose file and its per-service variables", () => {
  const config = generateDokployConfig(defaults);
  assert.equal(config.compose?.file, "docker-compose.dokploy.yml");
  assert.deepEqual(config.compose?.environmentVariables.postgres, ["POSTGRES_PASSWORD"]);
  assert.deepEqual(config.compose?.environmentVariables.redis, ["REDIS_PASSWORD"]);
  assert.deepEqual(config.compose?.environmentVariables["schema-apply"], ["POSTGRES_PASSWORD"]);
  for (const key of [
    "ADMIN_EMAILS",
    "BETTER_AUTH_SECRET",
    "POSTGRES_PASSWORD",
    "REDIS_PASSWORD",
    "SMTP_FROM",
    "SMTP_HOST",
    "SMTP_PASS",
    "SMTP_USER",
  ])
    assert.ok(
      (config.compose?.environmentVariables.server ?? []).includes(key),
      `server checklist missing ${key}`,
    );
  // The compose checklist exists for every topology and always names the blessed shape.
  for (const topology of ["app", "app-applier", "app-worker", "full"] as const) {
    const other = generateDokployConfig({ ...defaults, topology });
    assert.match(other.compose?.topology ?? "", /blessed/);
  }
});
