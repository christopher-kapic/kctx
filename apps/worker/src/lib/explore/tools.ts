import { type AgentTool, defineTool } from "@starter/agent-runtime";
import { z } from "zod";

import { exploreGlob, exploreGrep, exploreRead } from "./fs-ops.js";
import { resolveWithinRoot } from "./paths.js";

/**
 * Read-only codebase investigation tools, confined to `root`.
 *
 * Shape mirrors flycockpit's `docs-answerer` (glob / grep / read) so the chat
 * agent can answer dependency-usage questions from real source instead of
 * training memory — the overnight stand-in for kctx's OpenCode-backed
 * `query_dependency`.
 */
export function buildExploreTools(root: string): AgentTool[] {
  // Fail fast if the configured root is missing / not a directory.
  resolveWithinRoot(root, ".");

  const grepTool = defineTool({
    name: "grep",
    description:
      "Regex content search under the explore root. Use to find a function, type, export, or usage example. Prefer narrowing with path when you already know the subtree.",
    inputSchema: z.object({
      pattern: z.string().min(1).describe("JavaScript RegExp source (not /delimited/)"),
      path: z
        .string()
        .optional()
        .describe("Optional subdirectory or file relative to the explore root"),
      case_insensitive: z.boolean().optional().describe("Defaults to false"),
      max_matches: z.number().int().min(1).max(100).optional(),
    }),
    execute: ({ pattern, path: searchPath, case_insensitive, max_matches }) =>
      exploreGrep(root, pattern, {
        searchPath,
        caseInsensitive: case_insensitive,
        maxMatches: max_matches,
      }),
  });

  const globTool = defineTool({
    name: "glob",
    description:
      "List files matching a glob under the explore root (e.g. `**/*.{ts,tsx}`, `examples/**`, `**/README*`). Use to locate the public API surface or examples before reading.",
    inputSchema: z.object({
      pattern: z.string().min(1).describe("Glob pattern relative to path / explore root"),
      path: z.string().optional().describe("Optional subdirectory relative to the explore root"),
    }),
    execute: ({ pattern, path: searchPath }) => exploreGlob(root, pattern, searchPath ?? "."),
  });

  const readTool = defineTool({
    name: "read",
    description:
      "Read a specific text file once you have narrowed it down. Lines are returned as `N|content` with 1-based numbering. Use offset/limit to page large files.",
    inputSchema: z.object({
      path: z.string().min(1).describe("File path relative to the explore root"),
      offset: z.number().int().min(1).optional().describe("1-based start line (default 1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(400)
        .optional()
        .describe("Max lines to return (default 200, max 400)"),
    }),
    execute: ({ path: relativePath, offset, limit }) =>
      exploreRead(root, relativePath, { offset, limit }),
  });

  return [globTool, grepTool, readTool];
}
