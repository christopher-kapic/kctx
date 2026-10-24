/** Shared classification for CI and the production applier. Input is Prisma DDL. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// PostgreSQL lexical boundary, with standard_conforming_strings=on on the
// actual writer. Escape strings include their newline continuations. Comments
// nest. Unicode escape forms and dollar quoting are explicitly unsupported;
// never approximate a spelling that could hide control statements/identifiers.
function statements(sql) {
  const result = [];
  let tokens = [];
  let offset = 0;
  let start;
  const invalid = () => {
    throw new Error("Unsupported or unterminated PostgreSQL lexical form.");
  };
  if (sql.includes("\0")) invalid();
  const trivia = () => {
    const start = offset;
    while (offset < sql.length) {
      if (/[ \t\n\r\f\v]/.test(sql[offset])) offset++;
      else if (sql.startsWith("--", offset)) {
        while (offset < sql.length && !/[\r\n]/.test(sql[offset])) offset++;
      } else if (sql.startsWith("/*", offset)) {
        offset += 2;
        let depth = 1;
        while (depth && offset < sql.length) {
          if (sql.startsWith("/*", offset)) {
            depth++;
            offset += 2;
          } else if (sql.startsWith("*/", offset)) {
            depth--;
            offset += 2;
          } else offset++;
        }
        if (depth) invalid();
      } else break;
    }
    return /[\r\n]/.test(sql.slice(start, offset));
  };
  const quoted = (quote, escapes) => {
    const start = offset++;
    while (offset < sql.length) {
      const char = sql[offset++];
      if (escapes && char === "\\") {
        if (offset === sql.length) invalid();
        offset++;
      } else if (char === quote) {
        if (sql[offset] === quote) offset++;
        else return sql.slice(start, offset);
      }
    }
    return invalid();
  };
  while (offset < sql.length) {
    trivia();
    if (offset === sql.length) break;
    start ??= offset;
    const rest = sql.slice(offset);
    if (/^U&["']/i.test(rest) || /^\$(?:[A-Za-z_\u0080-\uffff][\w$\u0080-\uffff]*)?\$/.test(rest))
      invalid();
    let value;
    if (sql[offset] === '"') value = quoted('"', false);
    else if (/^[eEbBxXnN]'/.test(rest) || sql[offset] === "'") {
      const escapes = /^[eE]'/.test(rest);
      if (sql[offset] !== "'") offset++;
      quoted("'", escapes);
      // PostgreSQL joins newline-separated string fragments, retaining E's
      // backslash rules even when a later fragment has no E prefix.
      while (trivia() && sql[offset] === "'") quoted("'", escapes);
      value = "<literal>";
    } else {
      const word = /^[A-Za-z_\u0080-\uffff][\w$\u0080-\uffff]*/.exec(rest)?.[0];
      value = word || sql[offset];
      offset += value.length;
    }
    if (value === ";") {
      if (tokens.length) result.push({ tokens, start, end: offset });
      tokens = [];
      start = undefined;
    } else {
      tokens.push(value);
    }
  }
  if (tokens.length) result.push({ tokens, start, end: offset });
  return result;
}

const keyword = (value) => (value && !value.startsWith('"') ? value.toUpperCase() : "");
const identifier = (value) =>
  value?.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value?.toLowerCase();

// Only remove the pinned PostgreSQL renderer's enum-rebuild transaction pair.
// Match tokens (never raw SQL regexes), including the complete rename chain and
// each column cast. The returned bytes, not Prisma's wrapper bytes, are what the
// operator reviews/hashes and what the one transaction owner executes.
function enumRebuild(block) {
  let cursor = 0;
  const expect = (tokens, values) =>
    tokens.length === values.length && tokens.every((value, i) => value === values[i]);
  const name = (tokens, offset) => {
    if (!tokens[offset]?.startsWith('"')) return null;
    const length = tokens[offset + 1] === "." ? 3 : 1;
    if (length === 3 && !tokens[offset + 2]?.startsWith('"')) return null;
    return tokens.slice(offset, offset + length);
  };
  const first = block[cursor++]?.tokens || [];
  const type = name(first, 2);
  if (!type || !expect(first.slice(0, 2), ["CREATE", "TYPE"])) return false;
  const temporary = identifier(type.at(-1));
  if (!temporary.endsWith("_new")) return false;
  const quote = (value) => `"${value.replaceAll('"', '""')}"`;
  const original = [...type.slice(0, -1), quote(temporary.slice(0, -4))];
  const old = [...type.slice(0, -1), quote(`${temporary.slice(0, -4)}_old`)];
  const values = first.slice(2 + type.length);
  if (
    !expect(values.slice(0, 3), ["AS", "ENUM", "("]) ||
    values.at(-1) !== ")" ||
    values.length < 5 ||
    !values.slice(3, -1).every((value, i) => value === (i % 2 ? "," : "<literal>")) ||
    values.length % 2 !== 1
  )
    return false;
  const column = (tokens) => {
    const table = name(tokens, 2);
    if (!table || !expect(tokens.slice(0, 2), ["ALTER", "TABLE"])) return null;
    const offset = 2 + table.length;
    if (
      !expect(tokens.slice(offset, offset + 2), ["ALTER", "COLUMN"]) ||
      !tokens[offset + 2]?.startsWith('"')
    )
      return null;
    return {
      key: JSON.stringify([...table, tokens[offset + 2]]),
      name: tokens[offset + 2],
      tail: tokens.slice(offset + 3),
    };
  };
  const defaults = new Set();
  const casts = new Set();
  while (cursor < block.length) {
    const altered = column(block[cursor].tokens);
    if (!altered) break;
    const { key, name: field, tail } = altered;
    if (expect(tail, ["DROP", "DEFAULT"])) {
      if (casts.size || defaults.has(key)) return false;
      defaults.add(key);
    } else {
      const array = tail[1 + type.length] === "[" ? ["[", "]"] : [];
      if (
        casts.has(key) ||
        !expect(tail, [
          "TYPE",
          ...type,
          ...array,
          "USING",
          "(",
          field,
          ":",
          ":",
          "text",
          ":",
          ":",
          ...type,
          ...array,
          ")",
        ])
      )
        return false;
      casts.add(key);
    }
    cursor++;
  }
  if (
    !expect(block[cursor++]?.tokens || [], [
      "ALTER",
      "TYPE",
      ...original,
      "RENAME",
      "TO",
      old.at(-1),
    ]) ||
    !expect(block[cursor++]?.tokens || [], [
      "ALTER",
      "TYPE",
      ...type,
      "RENAME",
      "TO",
      original.at(-1),
    ]) ||
    !expect(block[cursor++]?.tokens || [], ["DROP", "TYPE", ...old])
  )
    return false;
  while (cursor < block.length) {
    const altered = column(block[cursor++].tokens);
    if (!altered || !defaults.delete(altered.key) || !casts.has(altered.key)) return false;
    const tail = altered.tail;
    if (!expect(tail.slice(0, 2), ["SET", "DEFAULT"]) || tail.length < 3) return false;
    // Default expressions are already single lexed statements. Their original
    // bytes are retained; they cannot contribute another transaction command.
  }
  // A removed default or removed column deliberately has no restoration;
  // Prisma emits the actual column removal in adjacent DDL after this block.
  return true;
}

export function normalizeDiff(sql) {
  const parsed = statements(sql);
  const removed = [];
  for (let index = 0; index < parsed.length; index++) {
    if (keyword(parsed[index].tokens[0]) !== "BEGIN") continue;
    const begin = parsed[index];
    let end = index + 1;
    while (end < parsed.length && keyword(parsed[end].tokens[0]) !== "COMMIT") end++;
    if (
      begin.tokens.length !== 1 ||
      parsed[end]?.tokens.length !== 1 ||
      !enumRebuild(parsed.slice(index + 1, end))
    )
      throw new Error("Unsupported Prisma enum transaction wrapper.");
    removed.push(begin, parsed[end]);
    index = end;
  }
  // Keep all comments, identifiers, values and executable SQL byte-for-byte.
  for (const span of removed.reverse()) sql = sql.slice(0, span.start) + sql.slice(span.end);
  return sql;
}

function tableIdentity(tokens) {
  let offset = keyword(tokens[2]) === "ONLY" ? 3 : 2;
  const first = identifier(tokens[offset]);
  if (!first) return null;
  if (tokens[offset + 1] === ".") return JSON.stringify([first, identifier(tokens[offset + 2])]);
  return JSON.stringify(["public", first]);
}

/** @returns {"destructive" | "risky" | "clean" | "unsupported"} */
export function classifyDiff(sql) {
  let destructive = false;
  let risky = false;
  const dropped = new Set();
  const added = new Set();
  let parsed;
  try {
    parsed = statements(normalizeDiff(sql));
  } catch {
    return "unsupported";
  }
  for (const { tokens } of parsed) {
    const words = tokens.map(keyword);
    const operation = words.slice(0, 2).join(" ");
    // Transaction control and psql metacommands cannot be run inside the
    // applier's atomic transaction. Unknown operations fail closed in both paths.
    if (
      !/^(CREATE (TABLE|INDEX|UNIQUE|TYPE|SCHEMA|SEQUENCE|EXTENSION)|ALTER (TABLE|TYPE|INDEX|SEQUENCE)|DROP (TABLE|TYPE|SCHEMA|INDEX|SEQUENCE|EXTENSION))$/.test(
        operation,
      ) ||
      words.includes("CONCURRENTLY") ||
      tokens.includes("\\") ||
      tokens.includes("$") ||
      tokens.some((value) => identifier(value) === "starter_control")
    )
      return "unsupported";
    if (words[0] === "DROP") destructive = true;
    const table = operation === "ALTER TABLE" ? tableIdentity(tokens) : null;
    for (let index = 0; index < words.length; index++) {
      const pair = words.slice(index, index + 2).join(" ");
      if (pair === "DROP COLUMN") destructive = true;
      if (pair === "ALTER COLUMN") {
        const remainder = words.slice(index + 3);
        const end = tokens.indexOf(",", index + 3);
        if ((end < 0 ? remainder : words.slice(index + 3, end)).includes("TYPE"))
          destructive = true;
      }
      if (pair === "SET NOT" || pair === "CREATE UNIQUE" || pair === "ADD CONSTRAINT") risky = true;
      if (table && (pair === "DROP CONSTRAINT" || pair === "ADD CONSTRAINT")) {
        const offset =
          pair === "DROP CONSTRAINT" && words[index + 2] === "IF" && words[index + 3] === "EXISTS"
            ? index + 4
            : index + 2;
        const name = identifier(tokens[offset]);
        if (!name) return "unsupported";
        (pair === "DROP CONSTRAINT" ? dropped : added).add(`${table}:${JSON.stringify(name)}`);
      }
    }
  }
  if (destructive || [...dropped].some((name) => !added.has(name))) return "destructive";
  return risky || dropped.size ? "risky" : "clean";
}

export function hasStatements(sql) {
  return statements(normalizeDiff(sql)).length > 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const sql = readFileSync(process.argv[3], "utf8");
    if (process.argv[2] === "has-statements") process.exit(hasStatements(sql) ? 0 : 1);
    if (process.argv[2] === "classify") console.log(classifyDiff(sql));
    else throw new Error("expected classify or has-statements");
  } catch {
    console.error("FATAL: could not classify schema diff.");
    process.exit(2);
  }
}
