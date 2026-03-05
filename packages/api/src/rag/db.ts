import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "node:path";
import { env } from "@kctx/env/server";

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  const dbPath = path.join(env.PACKAGES_PATH, "kctx-embeddings.db");
  _db = new Database(dbPath);
  sqliteVec.load(_db);
  _db.exec(
    "CREATE TABLE IF NOT EXISTS rag_metadata (key TEXT PRIMARY KEY, value TEXT)",
  );
  return _db;
}

export function ensureVecTable(dimension: number): void {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM rag_metadata WHERE key = 'dimension'")
    .get() as { value: string } | undefined;
  const storedDim = row ? parseInt(row.value, 10) : null;

  if (storedDim !== null && storedDim !== dimension) {
    db.exec("DROP TABLE IF EXISTS vec_chunks");
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      repo_id text partition key,
      embedding float[${dimension}],
      +file_path text,
      +chunk_text text
    )
  `);

  db.prepare(
    "INSERT OR REPLACE INTO rag_metadata (key, value) VALUES ('dimension', ?)",
  ).run(String(dimension));
}

export function deleteRepoChunks(repoId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM vec_chunks WHERE repo_id = ?").run(repoId);
}

export function insertChunks(
  repoId: string,
  chunks: Array<{
    filePath: string;
    text: string;
    embedding: Float32Array;
  }>,
): void {
  const db = getDb();
  const stmt = db.prepare(
    "INSERT INTO vec_chunks (repo_id, embedding, file_path, chunk_text) VALUES (?, ?, ?, ?)",
  );
  const tx = db.transaction(() => {
    for (const chunk of chunks) {
      stmt.run(repoId, chunk.embedding, chunk.filePath, chunk.text);
    }
  });
  tx();
}

export function searchChunks(
  repoId: string,
  queryEmbedding: Float32Array,
  k: number = 10,
): Array<{ file_path: string; chunk_text: string; distance: number }> {
  const db = getDb();
  return db
    .prepare(
      `SELECT file_path, chunk_text, distance
     FROM vec_chunks
     WHERE embedding MATCH ? AND k = ? AND repo_id = ?`,
    )
    .all(queryEmbedding, k, repoId) as Array<{
    file_path: string;
    chunk_text: string;
    distance: number;
  }>;
}
