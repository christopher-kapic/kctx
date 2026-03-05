# RAG with sqlite-vec for kctx query_dependency

## Problem

When `query_dependency` is called, kctx:
1. Looks up the package in Prisma DB
2. Finds the cloned repo path
3. Prepends `kctxHelper` text (a cached summary) if available
4. Sends the full query to OpenCode, which starts a new session
5. OpenCode's agent then uses glob/grep/read tools to explore the repo from scratch
6. The LLM decides which files to look at based on tool descriptions and the query

The bottleneck is step 5-6: **OpenCode has no index**. Every query triggers on-demand ripgrep/glob searches. The LLM must iteratively discover relevant files, often taking multiple tool call rounds. The `kctxHelper` summary helps guide queries but doesn't eliminate the file discovery overhead.

## Proposal: sqlite-vec RAG Layer

Pre-index each dependency repo's files as embeddings. When a query comes in, do a vector similarity search to find the most relevant files/chunks, then include those in the prompt sent to OpenCode — so it starts with the right context instead of searching for it.

### Architecture

```
User query
    |
    v
Generate embedding for query (via API)
    |
    v
sqlite-vec KNN search against repo's indexed embeddings
    |
    v
Top-k relevant file chunks returned
    |
    v
Prepend chunks to OpenCode prompt (like kctxHelper but dynamic)
    |
    v
OpenCode answers with relevant context already in prompt
```

### sqlite-vec Feasibility

**Installation**: `npm install sqlite-vec` — works with better-sqlite3 or Node 23.5+ built-in `node:sqlite`.

**Loading**:
```typescript
import * as sqliteVec from "sqlite-vec";
import Database from "better-sqlite3";

const db = new Database("repos.db");
sqliteVec.load(db);
```

**Schema for file chunks**:
```sql
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding FLOAT[1536],
  +file_path TEXT,
  +chunk_text TEXT,
  +repo_id TEXT
);
```

- Auxiliary columns (`+file_path`, `+chunk_text`) store metadata alongside vectors — no JOIN needed
- Partition keys could shard by repo: `repo_id TEXT PARTITION KEY`
- Supports up to 8192 dimensions, cosine/L2/L1 distance metrics
- Max k=4096 per KNN query (more than enough)

**Querying**:
```sql
SELECT chunk_id, file_path, chunk_text, distance
FROM vec_chunks
WHERE embedding MATCH ?    -- query embedding as Float32Array
  AND k = 10
  AND repo_id = 'opencode'; -- filter by repo via partition key
```

### Indexing Pipeline

For each dependency repo:
1. Walk the repo, collect source files (respecting .gitignore, skip binaries)
2. Chunk files (by function/class, or fixed-size ~500-1000 token windows with overlap)
3. Generate embeddings for each chunk via an embedding API (e.g. OpenAI `text-embedding-3-small` at 1536d, or a local model)
4. Insert into sqlite-vec
5. Re-index on git pull (diff-based: only re-embed changed files)

### Integration Points in kctx

The change would go in `apps/server/src/mcp/index.ts`, specifically in the `query_dependency` tool handler (~line 600-712):

1. **Before calling `queryOpencode`**: Run vector search against the query
2. **Append results after the query**: Relevant file chunks grouped by path
3. **kctxHelper stays as-is**: It provides high-level package context; RAG provides targeted code

#### Prompt Format

The enriched query sent to OpenCode would look like:

```
${kctxHelper}

${query}

Potentially relevant files:
./src/tool/grep.ts
\`\`\`
import { Ripgrep } from "../file/ripgrep";
...
\`\`\`
./src/tool/glob.ts
\`\`\`
import { Ripgrep } from "../file/ripgrep";
...
\`\`\`
```

kctxHelper gives the agent a map of the repo. The query is the actual question. The relevant files give it a head start so it can answer immediately or know exactly where to dig deeper.

Multiple chunks from the same file should be grouped under one path header to avoid repetition.

#### Pseudocode

```typescript
// In query_dependency handler, before calling queryOpencode
const queryEmbedding = await generateEmbedding(query);
const relevantChunks = vecDb.prepare(`
  SELECT file_path, chunk_text, distance
  FROM vec_chunks
  WHERE embedding MATCH ? AND k = 10 AND repo_id = ?
`).all(new Float32Array(queryEmbedding), pkg.identifier);

// Group chunks by file path
const fileChunks = new Map<string, string[]>();
for (const chunk of relevantChunks) {
  const existing = fileChunks.get(chunk.file_path) ?? [];
  existing.push(chunk.chunk_text);
  fileChunks.set(chunk.file_path, existing);
}

// Build the "Potentially relevant files" section
const ragContext = Array.from(fileChunks.entries())
  .map(([path, chunks]) => `${path}\n\`\`\`\n${chunks.join("\n...\n")}\n\`\`\``)
  .join("\n");

// Assemble final query
let enrichedQuery = "";
if (pkg.kctxHelper?.trim()) {
  enrichedQuery += `${pkg.kctxHelper}\n\n`;
}
enrichedQuery += query;
if (ragContext) {
  enrichedQuery += `\n\nPotentially relevant files:\n${ragContext}`;
}
```

### What This Buys Us

- **Fewer tool call rounds**: OpenCode starts with relevant files in context, reducing iterative glob/grep/read cycles
- **Faster time-to-answer**: The LLM can often answer directly from the provided context without any tool calls
- **Lower token usage**: Fewer back-and-forth tool calls = fewer tokens spent on exploration
- **Better answers**: Semantic search finds conceptually relevant code that keyword search might miss

### Concerns and Tradeoffs

**Embedding cost**: Each repo needs embedding generation. For a repo with ~500 source files chunked to ~2000 chunks, that's one API call per chunk. At OpenAI rates for `text-embedding-3-small`, this is ~$0.01 per repo. Trivial.

**Storage**: sqlite-vec stores vectors efficiently. 2000 chunks x 1536 dimensions x 4 bytes = ~12MB per repo. Manageable.

**Staleness**: Embeddings need updating when repos change. The existing `git pull` in query_dependency (line 634-639) could trigger incremental re-indexing of changed files.

**Embedding model dependency**: Requires access to an embedding API. Could use:
- OpenAI `text-embedding-3-small` (cheapest, good quality)
- A local model via Ollama (no API cost, but slower)
- The same provider already configured for OpenCode queries

**Chunking strategy matters**: Poor chunking = poor retrieval. Need to balance:
- Too small: loses context
- Too large: wastes context window space
- Best approach: AST-aware chunking (by function/class) for code, with fallback to sliding window

**Not a silver bullet**: Some queries are broad ("how does this library work?") and benefit more from the existing kctxHelper approach. RAG is best for specific questions ("how do I configure X?" / "what's the API for Y?"). OpenCode still needs to be in the loop to explore further when RAG results aren't sufficient.

## Verdict

**Yes, this is feasible and would likely speed up queries significantly.** The integration is straightforward:

1. sqlite-vec works in Node.js via npm with better-sqlite3
2. The vec0 virtual table with auxiliary columns fits the use case perfectly (store file paths and text alongside embeddings)
3. The existing kctx architecture already prepends context to queries (kctxHelper), so RAG context slots in naturally
4. Partition keys allow per-repo isolation in a single database

The biggest win: eliminating 2-5 tool call rounds per query (each round = LLM inference + tool execution latency). OpenCode still handles the full answer, but starts with the right files already in context.
