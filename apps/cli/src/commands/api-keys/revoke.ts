import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { client } from "../../client.js";

export const apiKeysRevokeCommand = defineCommand({
  meta: { name: "revoke", description: "Revoke an API key" },
  args: {
    id: {
      type: "positional",
      description: "API key ID to revoke",
      required: false,
    },
  },
  async run({ args }) {
    let keyId = args.id as string | undefined;

    if (!keyId) {
      const s = p.spinner();
      s.start("Fetching API keys...");
      const keys = await client.apiKey.list({});
      s.stop("API keys loaded.");

      const activeKeys = keys.filter((k) => !k.revokedAt);
      if (activeKeys.length === 0) {
        p.log.info("No active API keys to revoke.");
        return;
      }

      const selected = await p.select({
        message: "Select an API key to revoke",
        options: activeKeys.map((k) => ({
          value: k.id,
          label: k.name,
          hint: `created ${new Date(k.createdAt).toLocaleDateString()}`,
        })),
      });

      if (p.isCancel(selected)) {
        p.cancel("Cancelled.");
        return;
      }
      keyId = selected;
    }

    const confirmed = await p.confirm({
      message: "Are you sure you want to revoke this API key?",
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Cancelled.");
      return;
    }

    const s = p.spinner();
    s.start("Revoking API key...");

    try {
      await client.apiKey.revoke({ id: keyId });
      s.stop("API key revoked!");
    } catch (err) {
      s.stop("Failed to revoke API key.", 1);
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
