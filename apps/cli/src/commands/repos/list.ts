import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { client } from "../../client.js";

export const reposListCommand = defineCommand({
  meta: { name: "list", description: "List all repositories" },
  async run() {
    const s = p.spinner();
    s.start("Fetching repositories...");

    try {
      const repos = await client.repository.list({});
      s.stop("Repositories loaded.");

      if (repos.length === 0) {
        p.log.info("No repositories found.");
        return;
      }

      p.log.info(`${pc.bold(String(repos.length))} repository(ies):\n`);

      for (const repo of repos) {
        const visibility = repo.isPrivate
          ? pc.yellow("private")
          : pc.green("public");
        const pkgCount = repo._count.Packages;
        console.log(
          `  ${pc.cyan(`${repo.orgOrUser}/${repo.repoName}`)} ${pc.dim(`[${repo.gitProvider}]`)} ${visibility} ${pc.dim(`— ${pkgCount} package(s)`)}`,
        );
      }
    } catch (err) {
      s.stop("Failed to fetch repositories.", 1);
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
