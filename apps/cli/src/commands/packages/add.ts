import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { client } from "../../client.js";

export const packagesAddCommand = defineCommand({
  meta: { name: "add", description: "Add a new package" },
  async run() {
    p.intro(pc.bgCyan(pc.black(" Add Package ")));

    const initialValues = await p.group(
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
      },
      {
        onCancel: () => {
          p.cancel("Cancelled.");
          process.exit(0);
        },
      },
    );

    const s = p.spinner();

    try {
      // Check if repo exists or create it
      s.start("Checking repository...");
      const repos = await client.repository.list({});
      const existingRepo = repos.find(
        (r) => {
          try {
            const url = new URL(initialValues.gitUrl as string);
            const parts = url.pathname.split("/").filter(Boolean);
            return r.orgOrUser === parts[0] && r.repoName === parts[1]?.replace(/\.git$/, "");
          } catch {
            return false;
          }
        },
      );

      let repoId: string;
      let detectedBranch = "main";

      if (!existingRepo) {
        s.stop("Repository not found, cloning...");
        const s2 = p.spinner();
        s2.start("Cloning repository (this may take a moment)...");
        const newRepo = await client.repository.create({
          gitUrl: initialValues.gitUrl as string,
          isPrivate: initialValues.isPrivate as boolean,
          authMethod: (initialValues.isPrivate as boolean) ? "SSH" : "HTTPS",
        });
        s2.stop("Repository cloned!");
        repoId = newRepo.id;
        if ("defaultBranch" in newRepo && typeof newRepo.defaultBranch === "string") {
          detectedBranch = newRepo.defaultBranch;
        }
      } else {
        s.stop("Found existing repository.");
        repoId = existingRepo.id;
        try {
          const result = await client.repository.getDefaultBranch({ id: repoId });
          if (result.defaultBranch) detectedBranch = result.defaultBranch;
        } catch {
          // Use fallback
        }
      }

      // Prompt for remaining fields now that we know the default branch
      const extraValues = await p.group(
        {
          defaultTag: () =>
            p.text({
              message: "Default branch",
              defaultValue: detectedBranch,
              placeholder: detectedBranch,
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

      const s3 = p.spinner();
      s3.start("Creating package...");
      const pkg = await client.package.create({
        identifier: initialValues.identifier as string,
        displayName: (initialValues.displayName || initialValues.identifier) as string,
        packageManager: initialValues.packageManager as string,
        defaultTag: (extraValues.defaultTag || detectedBranch) as string,
        kctxHelper: (extraValues.kctxHelper as string) || undefined,
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
