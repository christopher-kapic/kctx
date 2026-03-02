import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { client } from "../../client.js";

export const packagesListCommand = defineCommand({
  meta: { name: "list", description: "List all packages" },
  async run() {
    const s = p.spinner();
    s.start("Fetching packages...");

    try {
      const packages = await client.package.list({});
      s.stop("Packages loaded.");

      if (packages.length === 0) {
        p.log.info("No packages found. Use 'kctx packages add' to create one.");
        return;
      }

      p.log.info(`${pc.bold(String(packages.length))} package(s):\n`);

      for (const pkg of packages) {
        const repo = pkg.Repository;
        const repoStr = repo
          ? pc.dim(`${repo.orgOrUser}/${repo.repoName}`)
          : pc.dim("no repo");
        console.log(
          `  ${pc.green(pkg.identifier)} ${pc.dim("—")} ${pkg.displayName} ${pc.dim(`[${pkg.packageManager}]`)} ${repoStr} ${pc.dim(`tag:${pkg.defaultTag}`)}`,
        );
      }
    } catch (err) {
      s.stop("Failed to fetch packages.", 1);
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
