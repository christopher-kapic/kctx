import { ORPCError } from "@orpc/server";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { simpleGit } from "simple-git";

import prisma from "@kctx/db";
import { env } from "@kctx/env/server";

import { protectedProcedure } from "../index";

/** Detect the default branch for a cloned repository */
async function getDefaultBranch(clonedPath: string): Promise<string> {
  const git = simpleGit(clonedPath);

  // Try symbolic-ref first (most reliable for cloned repos)
  try {
    const ref = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    const branch = ref.trim().replace("refs/remotes/origin/", "");
    if (branch) return branch;
  } catch {
    // Not set
  }

  // Fallback: git remote show origin
  try {
    const info = await git.raw(["remote", "show", "origin"]);
    const match = info.match(/HEAD branch:\s*(.+)/);
    if (match?.[1]?.trim()) return match[1].trim();
  } catch {
    // Remote unavailable
  }

  // Fallback: check local branches
  try {
    const branches = await git.branchLocal();
    for (const name of ["main", "master", "develop", "dev"]) {
      if (branches.all.includes(name)) return name;
    }
    if (branches.current) return branches.current;
  } catch {
    // No branches
  }

  return "main";
}

export const repositoryRouter = {
  list: protectedProcedure.handler(async () => {
    return prisma.repository.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { Packages: true } },
        Packages: { select: { urls: true }, take: 1 },
      },
    });
  }),

  getDefaultBranch: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input }) => {
      const repo = await prisma.repository.findUnique({
        where: { id: input.id },
      });
      if (!repo) {
        throw new ORPCError("NOT_FOUND", { message: "Repository not found" });
      }
      if (!repo.clonedPath) {
        return { defaultBranch: "main" };
      }
      const defaultBranch = await getDefaultBranch(repo.clonedPath);
      return { defaultBranch };
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input }) => {
      const repo = await prisma.repository.findUnique({
        where: { id: input.id },
      });
      if (!repo) {
        throw new ORPCError("NOT_FOUND", { message: "Repository not found" });
      }
      return repo;
    }),

  create: protectedProcedure
    .input(
      z.object({
        gitUrl: z.string().url(),
        isPrivate: z.boolean().default(false),
        authMethod: z.enum(["HTTPS", "SSH", "GITHUB_APP"]).default("HTTPS"),
        sshPrivateKey: z.string().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { gitProvider, orgOrUser, repoName } = parseGitUrl(input.gitUrl);

      // Check if repo already exists
      const existing = await prisma.repository.findUnique({
        where: {
          gitProvider_orgOrUser_repoName: {
            gitProvider,
            orgOrUser,
            repoName,
          },
        },
      });
      if (existing) {
        throw new ORPCError("CONFLICT", {
          message: "Repository already exists",
        });
      }

      // If SSH clone, check settings
      if (input.authMethod === "SSH" || input.sshPrivateKey) {
        const settings = await prisma.siteSettings.findUnique({
          where: { id: "default" },
        });
        if (settings && !settings.sshCloningEnabled) {
          throw new ORPCError("BAD_REQUEST", {
            message: "SSH cloning is disabled by administrator",
          });
        }
      }

      const clonedPath = path.join(
        env.PACKAGES_PATH,
        gitProvider,
        orgOrUser,
        repoName,
      );

      // Clone the repo
      await cloneRepository({
        gitUrl: input.gitUrl,
        clonedPath,
        sshPrivateKey: input.sshPrivateKey,
      });

      const detectedBranch = await getDefaultBranch(clonedPath);

      const repo = await prisma.repository.create({
        data: {
          gitProvider,
          orgOrUser,
          repoName,
          gitUrl: input.gitUrl,
          isPrivate: input.isPrivate,
          authMethod: input.authMethod,
          clonedPath,
        },
      });

      return { ...repo, defaultBranch: detectedBranch };
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        sshPrivateKey: z.string().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const repo = await prisma.repository.findUnique({
        where: { id: input.id },
      });
      if (!repo) {
        throw new ORPCError("NOT_FOUND", { message: "Repository not found" });
      }
      if (!repo.clonedPath) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Repository has no cloned path",
        });
      }

      // Private repos need an SSH key
      if (repo.isPrivate && !input.sshPrivateKey) {
        throw new ORPCError("BAD_REQUEST", {
          message:
            "SSH private key is required to update a private repository",
        });
      }

      if (input.sshPrivateKey) {
        const settings = await prisma.siteSettings.findUnique({
          where: { id: "default" },
        });
        if (settings && !settings.sshCloningEnabled) {
          throw new ORPCError("BAD_REQUEST", {
            message: "SSH cloning is disabled by administrator",
          });
        }
      }

      await pullRepository({
        clonedPath: repo.clonedPath,
        sshPrivateKey: input.sshPrivateKey,
      });

      return { success: true };
    }),

  bulkUpdate: protectedProcedure
    .input(
      z.object({
        sshPrivateKey: z.string().optional(),
      }).optional(),
    )
    .handler(async ({ input }) => {
      const repos = await prisma.repository.findMany();

      let sshEnabled = true;
      if (input?.sshPrivateKey) {
        const settings = await prisma.siteSettings.findUnique({
          where: { id: "default" },
        });
        if (settings && !settings.sshCloningEnabled) {
          sshEnabled = false;
        }
      }

      const results: Array<{
        id: string;
        repoName: string;
        status: "success" | "skipped" | "failed";
        reason?: string;
      }> = [];

      for (const repo of repos) {
        if (!repo.clonedPath) {
          results.push({
            id: repo.id,
            repoName: `${repo.orgOrUser}/${repo.repoName}`,
            status: "skipped",
            reason: "No cloned path",
          });
          continue;
        }

        if (repo.isPrivate && !input?.sshPrivateKey) {
          results.push({
            id: repo.id,
            repoName: `${repo.orgOrUser}/${repo.repoName}`,
            status: "skipped",
            reason: "Private repository requires SSH key",
          });
          continue;
        }

        if (repo.isPrivate && input?.sshPrivateKey && !sshEnabled) {
          results.push({
            id: repo.id,
            repoName: `${repo.orgOrUser}/${repo.repoName}`,
            status: "skipped",
            reason: "SSH cloning is disabled by administrator",
          });
          continue;
        }

        try {
          await pullRepository({
            clonedPath: repo.clonedPath,
            sshPrivateKey: repo.isPrivate ? input?.sshPrivateKey : undefined,
          });
          results.push({
            id: repo.id,
            repoName: `${repo.orgOrUser}/${repo.repoName}`,
            status: "success",
          });
        } catch (error) {
          results.push({
            id: repo.id,
            repoName: `${repo.orgOrUser}/${repo.repoName}`,
            status: "failed",
            reason:
              error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      return { results };
    }),

  delete: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        removeFiles: z.boolean().default(false),
      }),
    )
    .handler(async ({ input }) => {
      const repo = await prisma.repository.findUnique({
        where: { id: input.id },
        include: { Packages: { select: { id: true } } },
      });
      if (!repo) {
        throw new ORPCError("NOT_FOUND", { message: "Repository not found" });
      }

      if (repo.Packages.length > 0) {
        throw new ORPCError("CONFLICT", {
          message:
            "Cannot delete repository with linked packages. Remove packages first.",
        });
      }

      if (input.removeFiles && repo.clonedPath) {
        try {
          fs.rmSync(repo.clonedPath, { recursive: true, force: true });
        } catch {
          // Best effort removal
        }
      }

      await prisma.repository.delete({ where: { id: input.id } });

      return { success: true };
    }),
};

/** Parse a git URL into provider, org, and repo name */
function parseGitUrl(gitUrl: string): {
  gitProvider: string;
  orgOrUser: string;
  repoName: string;
} {
  // Handle SSH URLs: git@github.com:user/repo.git
  const sshMatch = gitUrl.match(
    /^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (sshMatch) {
    return {
      gitProvider: sshMatch[1]!,
      orgOrUser: sshMatch[2]!,
      repoName: sshMatch[3]!,
    };
  }

  // Handle HTTPS URLs: https://github.com/user/repo.git
  try {
    const url = new URL(gitUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return {
        gitProvider: url.hostname,
        orgOrUser: parts[0]!,
        repoName: parts[1]!.replace(/\.git$/, ""),
      };
    }
  } catch {
    // Not a valid URL
  }

  throw new ORPCError("BAD_REQUEST", {
    message:
      "Could not parse git URL. Expected format: https://github.com/user/repo or git@github.com:user/repo",
  });
}

/** Clone a git repository, optionally using an SSH private key */
async function cloneRepository({
  gitUrl,
  clonedPath,
  sshPrivateKey,
}: {
  gitUrl: string;
  clonedPath: string;
  sshPrivateKey?: string;
}) {
  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(clonedPath), { recursive: true });

  let tempKeyPath: string | undefined;
  const gitOptions: Record<string, string> = {};

  try {
    if (sshPrivateKey) {
      // Write SSH key to a temp file
      tempKeyPath = path.join(
        os.tmpdir(),
        `kctx-ssh-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      fs.writeFileSync(tempKeyPath, sshPrivateKey, { mode: 0o600 });
      gitOptions.GIT_SSH_COMMAND = `ssh -i ${tempKeyPath} -o StrictHostKeyChecking=no`;
    }

    const git = simpleGit();
    await git.env(gitOptions).clone(gitUrl, clonedPath);
  } catch (error) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: `Failed to clone repository: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  } finally {
    // Always clean up the temp key file
    if (tempKeyPath) {
      try {
        fs.unlinkSync(tempKeyPath);
      } catch {
        // Best effort cleanup
      }
    }
  }
}

/** Pull (update) a cloned git repository, optionally using an SSH private key */
async function pullRepository({
  clonedPath,
  sshPrivateKey,
}: {
  clonedPath: string;
  sshPrivateKey?: string;
}) {
  let tempKeyPath: string | undefined;
  const gitOptions: Record<string, string> = {};

  try {
    if (sshPrivateKey) {
      tempKeyPath = path.join(
        os.tmpdir(),
        `kctx-ssh-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      fs.writeFileSync(tempKeyPath, sshPrivateKey, { mode: 0o600 });
      gitOptions.GIT_SSH_COMMAND = `ssh -i ${tempKeyPath} -o StrictHostKeyChecking=no`;
    }

    const git = simpleGit(clonedPath);
    await git.env(gitOptions).pull();
  } catch (error) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: `Failed to pull repository: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  } finally {
    if (tempKeyPath) {
      try {
        fs.unlinkSync(tempKeyPath);
      } catch {
        // Best effort cleanup
      }
    }
  }
}

export { parseGitUrl, cloneRepository, pullRepository };
