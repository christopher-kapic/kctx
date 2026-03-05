import { searchChunks, ensureVecTable } from "./db";
import {
  generateEmbedding,
  isEmbeddingConfigured,
  type EmbeddingSettings,
} from "./embeddings";

/**
 * Search for relevant code chunks in a repository's embeddings.
 * Returns a formatted string of file paths and their content,
 * or empty string if embedding is not configured or search fails.
 */
export async function searchRelevantChunks(
  repoId: string,
  query: string,
  settings: EmbeddingSettings,
  k: number = 10,
): Promise<string> {
  if (!isEmbeddingConfigured(settings)) return "";

  try {
    const { embedding, dimension } = await generateEmbedding(query, settings);
    ensureVecTable(dimension);

    const results = searchChunks(repoId, embedding, k);
    if (results.length === 0) return "";

    // Group chunks by file path
    const fileChunks = new Map<string, string[]>();
    for (const result of results) {
      const existing = fileChunks.get(result.file_path) ?? [];
      existing.push(result.chunk_text);
      fileChunks.set(result.file_path, existing);
    }

    // Build the context string
    return Array.from(fileChunks.entries())
      .map(
        ([fp, chunks]) =>
          `${fp}\n\`\`\`\n${chunks.join("\n...\n")}\n\`\`\``,
      )
      .join("\n");
  } catch (error) {
    console.error(
      "[RAG] Search error:",
      error instanceof Error ? error.message : String(error),
    );
    return "";
  }
}
