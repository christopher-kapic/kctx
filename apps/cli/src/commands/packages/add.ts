import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { client } from "../../client.js";

export const packagesAddCommand = defineCommand({
  meta: { name: "add", description: "Add a new package" },
  async run() {
    p.intro(pc.bgCyan(pc.black(" Add Package ")));

    const values = await p.group(
      {
        identifier: () =>
          p.text({
            message: "Package identifier",
            placeholder: "e.g. @hookform/resolvers",
            validate: (v) => (v.length === 0 ? "Required" : undefined),
          }),
        displayName: ({ results }) =>
          p.text({
            message: "Display name",
            defaultValue: results.identifier as string,
            placeholder: results.identifier as string,
          }),
        packageManager: () =>
          p.select({
            message: "Package manager",
            initialValue: "npm",
            options: [
              { value: "npm", label: "npm" },
              { value: "pnpm", label: "pnpm" },
              { value: "yarn", label: "yarn" },
              { value: "pip", label: "pip" },
              { value: "cargo", label: "cargo" },
              { value: "go", label: "go" },
            ],
          }),
        gitUrl: () =>
          p.text({
            message: "Git URL",
            placeholder: "https://github.com/user/repo",
            validate: (v) => (v.length === 0 ? "Required" : undefined),
          }),
        isPrivate: () =>
          p.confirm({ message: "Is this a private repository?", initialValue: false }),
        defaultTag: () =>
          p.text({
            message: "Default tag/branch",
            defaultValue: "main",
            placeholder: "main",
          }),
        kctxHelper: () =>
          p.text({
            message: "Helper text (optional)",
            defaultValue: "",
            placeholder: "Optional description for AI tools",
          }),
      },
      {
        onCancel: () => {
          p.cancel("Cancelled.");
          process.exit(0);
        },
      },
    );

    const confirmed = await p.confirm({ message: "Create this package?" });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Cancelled.");
      return;
    }

    const s = p.spinner();

    try {
      // Check if repo exists or create it
      s.start("Checking repository...");
      const repos = await client.repository.list({});
      const existingRepo = repos.find(
        (r) => {
          try {
            const url = new URL(values.gitUrl as string);
            const parts = url.pathname.split("/").filter(Boolean);
            return r.orgOrUser === parts[0] && r.repoName === parts[1]?.replace(/\.git$/, "");
          } catch {
            return false;
          }
        },
      );

      let repoId: string;

      if (!existingRepo) {
        s.stop("Repository not found, cloning...");
        const s2 = p.spinner();
        s2.start("Cloning repository (this may take a moment)...");
        const newRepo = await client.repository.create({
          gitUrl: values.gitUrl as string,
          isPrivate: values.isPrivate as boolean,
          authMethod: (values.isPrivate as boolean) ? "SSH" : "HTTPS",
        });
        s2.stop("Repository cloned!");
        repoId = newRepo.id;
      } else {
        s.stop("Found existing repository.");
        repoId = existingRepo.id;
      }

      const s3 = p.spinner();
      s3.start("Creating package...");
      const pkg = await client.package.create({
        identifier: values.identifier as string,
        displayName: (values.displayName || values.identifier) as string,
        packageManager: values.packageManager as string,
        defaultTag: (values.defaultTag || "main") as string,
        kctxHelper: (values.kctxHelper as string) || undefined,
        urls: {},
        repositoryId: repoId,
      });
      s3.stop("Package created!");

      p.log.success(`${pc.green(pkg.identifier)} added successfully`);
    } catch (err) {
      s.stop("Failed.", 1);
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    p.outro("Done");
  },
});
