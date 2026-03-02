import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { client } from "../../client.js";

export const packagesRemoveCommand = defineCommand({
  meta: { name: "remove", description: "Remove a package" },
  args: {
    id: {
      type: "positional",
      description: "Package ID to remove",
      required: false,
    },
  },
  async run({ args }) {
    let packageId = args.id as string | undefined;

    if (!packageId) {
      const s = p.spinner();
      s.start("Fetching packages...");
      const packages = await client.package.list({});
      s.stop("Packages loaded.");

      if (packages.length === 0) {
        p.log.info("No packages found.");
        return;
      }

      const selected = await p.select({
        message: "Select a package to remove",
        options: packages.map((pkg) => ({
          value: pkg.id,
          label: `${pkg.identifier} — ${pkg.displayName}`,
        })),
      });

      if (p.isCancel(selected)) {
        p.cancel("Cancelled.");
        return;
      }
      packageId = selected;
    }

    const confirmed = await p.confirm({
      message: `Are you sure you want to remove this package?`,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Cancelled.");
      return;
    }

    const s = p.spinner();
    s.start("Removing package...");

    try {
      await client.package.delete({ id: packageId });
      s.stop("Package removed!");
      p.log.success("Package deleted successfully");
    } catch (err) {
      s.stop("Failed to remove package.", 1);
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
