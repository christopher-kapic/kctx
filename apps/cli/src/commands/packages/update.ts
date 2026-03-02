import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { client } from "../../client.js";

export const packagesUpdateCommand = defineCommand({
  meta: { name: "update", description: "Update a package's metadata" },
  args: {
    id: {
      type: "positional",
      description: "Package ID to update",
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
        message: "Select a package to update",
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

    const s = p.spinner();
    s.start("Fetching package details...");
    let pkg;
    try {
      pkg = await client.package.get({ id: packageId });
      s.stop("Package loaded.");
    } catch (err) {
      s.stop("Failed.", 1);
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    p.log.info(`Editing ${pc.green(pkg.identifier)} (leave blank to keep current value)`);

    const values = await p.group(
      {
        displayName: () =>
          p.text({
            message: "Display name",
            defaultValue: pkg.displayName,
            placeholder: pkg.displayName,
          }),
        defaultTag: () =>
          p.text({
            message: "Default tag",
            defaultValue: pkg.defaultTag,
            placeholder: pkg.defaultTag,
          }),
        kctxHelper: () =>
          p.text({
            message: "Helper text",
            defaultValue: pkg.kctxHelper || "",
            placeholder: pkg.kctxHelper || "(none)",
          }),
      },
      {
        onCancel: () => {
          p.cancel("Cancelled.");
          process.exit(0);
        },
      },
    );

    const s2 = p.spinner();
    s2.start("Updating package...");

    try {
      await client.package.update({
        id: packageId,
        displayName: values.displayName as string,
        defaultTag: values.defaultTag as string,
        kctxHelper: (values.kctxHelper as string) || null,
      });
      s2.stop("Package updated!");
    } catch (err) {
      s2.stop("Failed to update package.", 1);
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
