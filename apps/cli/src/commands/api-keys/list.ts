import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { client } from "../../client.js";

export const apiKeysListCommand = defineCommand({
  meta: { name: "list", description: "List your API keys" },
  async run() {
    const s = p.spinner();
    s.start("Fetching API keys...");

    try {
      const keys = await client.apiKey.list({});
      s.stop("API keys loaded.");

      if (keys.length === 0) {
        p.log.info("No API keys found. Use 'kctx api-keys create' to create one.");
        return;
      }

      p.log.info(`${pc.bold(String(keys.length))} API key(s):\n`);

      for (const key of keys) {
        const status = key.revokedAt
          ? pc.red("revoked")
          : pc.green("active");
        const created = new Date(key.createdAt).toLocaleDateString();
        console.log(
          `  ${pc.bold(key.name)} ${pc.dim(`(${key.id})`)} ${status} ${pc.dim(`created ${created}`)}`,
        );
      }
    } catch (err) {
      s.stop("Failed to fetch API keys.", 1);
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
