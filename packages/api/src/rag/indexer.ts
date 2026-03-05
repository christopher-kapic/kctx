import { simpleGit } from "simple-git";
import { readFile } from "node:fs/promises";
import path from "node:path";

import prisma from "@kctx/db";
import { deleteRepoChunks, ensureVecTable, insertChunks } from "./db";
import {
  generateEmbeddings,
  type EmbeddingSettings,
} from "./embeddings";

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
  ".woff", ".woff2", ".eot", ".ttf", ".otf",
  ".mp3", ".mp4", ".avi", ".mov", ".webm", ".ogg", ".wav",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".class", ".pyc",
  ".wasm", ".map",
  ".lock", ".sum",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "__pycache__", ".tox", ".venv", "venv",
  "vendor", "target",
  ".idea", ".vscode",
]);

const MAX_FILE_SIZE = 100_000; // 100KB
const CHUNK_SIZE = 4000; // ~1000 tokens
const CHUNK_OVERLAP = 400; // ~100 tokens overlap

function shouldSkipFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;

  const parts = filePath.split("/");
  return parts.some((p) => SKIP_DIRS.has(p));
}

function chunkText(
  content: string,
  filePath: string,
): Array<{ filePath: string; text: string }> {
  if (content.length <= CHUNK_SIZE) {
    return [{ filePath, text: content }];
  }

  const chunks: Array<{ filePath: string; text: string }> = [];
  let start = 0;

  while (start < content.length) {
    const end = Math.min(start + CHUNK_SIZE, content.length);
    chunks.push({ filePath, text: content.slice(start, end) });
    start += CHUNK_SIZE - CHUNK_OVERLAP;
    if (end === content.length) break;
  }

  return chunks;
}

async function doIndex(
  repoId: string,
  repoLabel: string,
  repoPath: string,
  settings: EmbeddingSettings,
): Promise<void> {
  let progress = { phase: "reading files", percent: 0 };
  const heartbeat = setInterval(() => {
    console.log(`[RAG] Indexing ${repoLabel} (${repoId}): ${progress.phase} (${progress.percent}%)`);
  }, 10_000);

  try {
    const git = simpleGit(repoPath);

    // Get all tracked files
    const lsOutput = await git.raw(["ls-files"]);
    const files = lsOutput
      .trim()
      .split("\n")
      .filter((f) => f && !shouldSkipFile(f));

    // Read and chunk files
    const allChunks: Array<{ filePath: string; text: string }> = [];

    for (let i = 0; i < files.length; i++) {
      try {
        const fullPath = path.join(repoPath, files[i]!);
        const content = await readFile(fullPath, "utf-8");
        if (content.length > MAX_FILE_SIZE || content.length === 0) continue;

        const chunks = chunkText(content, files[i]!);
        allChunks.push(...chunks);
      } catch {
        // Skip files that can't be read (binary, permissions, etc.)
        continue;
      }
      progress.percent = Math.round(((i + 1) / files.length) * 100);
    }

    if (allChunks.length === 0) return;

    // Generate embeddings
    progress = { phase: "generating embeddings", percent: 0 };
    const texts = allChunks.map((c) => c.text);
    const { embeddings, dimension } = await generateEmbeddings(texts, settings, (done, total) => {
      progress.percent = Math.round((done / total) * 100);
    });

    // Ensure the vec table exists with the right dimension
    ensureVecTable(dimension);

    // Clear existing chunks for this repo and insert new ones
    deleteRepoChunks(repoId);

    const chunksWithEmbeddings = allChunks.map((chunk, i) => ({
      filePath: chunk.filePath,
      text: chunk.text,
      embedding: embeddings[i]!,
    }));

    insertChunks(repoId, chunksWithEmbeddings);

    console.log(
      `[RAG] Indexed ${repoLabel} (${repoId}): ${files.length} files, ${allChunks.length} chunks`,
    );
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Index a repository's files as embeddings. Manages the embeddingStatus
 * on the Repository record automatically.
 */
export async function indexRepository(
  repoId: string,
  repoPath: string,
  headCommit: string,
  settings: EmbeddingSettings,
): Promise<void> {
  const repo = await prisma.repository.update({
    where: { id: repoId },
    data: { embeddingStatus: "INDEXING", embeddingError: null },
  });
  const repoLabel = `${repo.orgOrUser}/${repo.repoName}`;

  try {
    await doIndex(repoId, repoLabel, repoPath, settings);
    await prisma.repository.update({
      where: { id: repoId },
      data: {
        embeddingStatus: "INDEXED",
        lastIndexedCommit: headCommit,
        embeddingError: null,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[RAG] Index failed for ${repoLabel} (${repoId}):`, message);
    await prisma.repository.update({
      where: { id: repoId },
      data: {
        embeddingStatus: "FAILED",
        embeddingError: message,
      },
    });
  }
}
