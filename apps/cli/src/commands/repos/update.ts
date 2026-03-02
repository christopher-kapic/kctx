import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { client } from "../../client.js";

export const reposUpdateCommand = defineCommand({
  meta: { name: "update", description: "Update (git pull) repositories" },
  args: {
    all: {
      type: "boolean",
      description: "Update all repositories",
      default: false,
    },
    "ssh-key": {
      type: "string",
      description: "SSH private key for private repos (or path to key file)",
      required: false,
    },
  },
  async run({ args }) {
    if (args.all) {
      // Bulk update
      const s = p.spinner();
      s.start("Updating all repositories...");

      try {
        const input = args["ssh-key"]
          ? { sshPrivateKey: await readKeyArg(args["ssh-key"]) }
          : {};
        const result = await client.repository.bulkUpdate(input);
        s.stop("Bulk update complete.");

        for (const r of result.results) {
          if (r.status === "success") {
            p.log.success(`${pc.green("✓")} ${r.repoName}`);
          } else if (r.status === "skipped") {
            p.log.warn(`${pc.yellow("○")} ${r.repoName} — ${r.reason}`);
          } else {
            p.log.error(`${pc.red("✗")} ${r.repoName} — ${r.reason}`);
          }
        }
      } catch (err) {
        s.stop("Failed.", 1);
        p.log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }

    // Single repo update — pick from list
    const s = p.spinner();
    s.start("Fetching repositories...");
    let repos;
    try {
      repos = await client.repository.list({});
      s.stop("Repositories loaded.");
    } catch (err) {
      s.stop("Failed.", 1);
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
      return;
    }

    if (repos.length === 0) {
      p.log.info("No repositories found.");
      return;
    }

    const selected = await p.select({
      message: "Select a repository to update",
      options: repos.map((r) => ({
        value: r.id,
        label: `${r.orgOrUser}/${r.repoName}${r.isPrivate ? " (private)" : ""}`,
        hint: r.gitProvider,
      })),
    });

    if (p.isCancel(selected)) {
      p.cancel("Cancelled.");
      return;
    }

    const repo = repos.find((r) => r.id === selected)!;
    let sshKey: string | undefined;

    if (repo.isPrivate) {
      const keyInput = await p.text({
        message: "SSH private key (paste key or path to file)",
        validate: (v) => (v.length === 0 ? "Required for private repos" : undefined),
      });

      if (p.isCancel(keyInput)) {
        p.cancel("Cancelled.");
        return;
      }
      sshKey = await readKeyArg(keyInput);
    }

    const s2 = p.spinner();
    s2.start(`Updating ${repo.orgOrUser}/${repo.repoName}...`);

    try {
      await client.repository.update({
        id: selected,
        sshPrivateKey: sshKey,
      });
      s2.stop("Repository updated!");
    } catch (err) {
      s2.stop("Failed to update repository.", 1);
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

async function readKeyArg(input: string): Promise<string> {
  // If it looks like a file path, read it
  const { existsSync, readFileSync } = await import("node:fs");
  if (existsSync(input)) {
    return readFileSync(input, "utf-8");
  }
  return input;
}
