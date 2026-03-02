import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { client } from "../../client.js";

export const apiKeysCreateCommand = defineCommand({
  meta: { name: "create", description: "Create a new API key" },
  args: {
    name: {
      type: "string",
      description: "Name for the API key",
      required: false,
    },
  },
  async run({ args }) {
    let name = args.name;

    if (!name) {
      const input = await p.text({
        message: "API key name",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      });
      if (p.isCancel(input)) {
        p.cancel("Cancelled.");
        return;
      }
      name = input;
    }

    const s = p.spinner();
    s.start("Creating API key...");

    try {
      const result = await client.apiKey.create({ name });
      s.stop("API key created!");

      p.log.warning(
        "Save this key now — it won't be shown again!",
      );
      console.log(`\n  ${pc.bold(pc.green(result.key))}\n`);
      p.log.info(`Name: ${result.name}`);
    } catch (err) {
      s.stop("Failed to create API key.", 1);
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
