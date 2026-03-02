import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { client } from "../../client.js";

export const settingsGetCommand = defineCommand({
  meta: { name: "get", description: "Get site settings (admin only)" },
  async run() {
    const s = p.spinner();
    s.start("Fetching settings...");

    try {
      const settings = await client.settings.get({});
      s.stop("Settings loaded.");

      console.log(`\n  ${pc.bold("SSH Cloning:")}     ${settings.sshCloningEnabled ? pc.green("enabled") : pc.red("disabled")}`);
      console.log(`  ${pc.bold("OpenCode URL:")}    ${settings.opencodeUrl || pc.dim("(not set)")}`);
      console.log(`  ${pc.bold("OpenCode Timeout:")} ${settings.opencodeTimeoutMs ? `${settings.opencodeTimeoutMs}ms` : pc.dim("(default)")}\n`);
    } catch (err) {
      s.stop("Failed to fetch settings.", 1);
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
