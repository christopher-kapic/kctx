import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { client } from "../../client.js";

export const settingsSetCommand = defineCommand({
  meta: { name: "set", description: "Update site settings (admin only)" },
  args: {
    "ssh-cloning": {
      type: "string",
      description: "Enable/disable SSH cloning (true/false)",
      required: false,
    },
    "opencode-url": {
      type: "string",
      description: "OpenCode service URL",
      required: false,
    },
    "opencode-timeout": {
      type: "string",
      description: "OpenCode timeout in ms",
      required: false,
    },
  },
  async run({ args }) {
    const updates: {
      sshCloningEnabled?: boolean;
      opencodeUrl?: string;
      opencodeTimeoutMs?: number;
    } = {};

    if (args["ssh-cloning"] !== undefined) {
      updates.sshCloningEnabled = args["ssh-cloning"] === "true";
    }
    if (args["opencode-url"] !== undefined) {
      updates.opencodeUrl = args["opencode-url"];
    }
    if (args["opencode-timeout"] !== undefined) {
      updates.opencodeTimeoutMs = parseInt(args["opencode-timeout"], 10);
    }

    if (Object.keys(updates).length === 0) {
      p.log.info("No settings specified. Use flags: --ssh-cloning, --opencode-url, --opencode-timeout");
      return;
    }

    const s = p.spinner();
    s.start("Updating settings...");

    try {
      const result = await client.settings.update(updates);
      s.stop("Settings updated!");

      console.log(`\n  ${pc.bold("SSH Cloning:")}     ${result.sshCloningEnabled ? pc.green("enabled") : pc.red("disabled")}`);
      console.log(`  ${pc.bold("OpenCode URL:")}    ${result.opencodeUrl || pc.dim("(not set)")}`);
      console.log(`  ${pc.bold("OpenCode Timeout:")} ${result.opencodeTimeoutMs ? `${result.opencodeTimeoutMs}ms` : pc.dim("(default)")}\n`);
    } catch (err) {
      s.stop("Failed to update settings.", 1);
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
