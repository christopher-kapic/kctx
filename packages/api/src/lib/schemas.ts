import { z } from "zod";

/** Opaque entity primary key (cuid2-ish). */
export const entityId = z.string().min(1).max(64);

/**
 * Short user-facing string: titles, names, one-line labels.
 *
 * Trimmed and non-empty. A name these schemas describe as "text" must not
 * accept `""` or `"   "` — a blank title renders as an empty row the user
 * cannot see or click, and every caller so far would have had to re-add the
 * check itself. Fields that are genuinely optional should say so with
 * `.optional()` rather than by allowing an empty string.
 */
export const shortText = z.string().trim().min(1).max(200);

/** Long user-facing string: bodies, descriptions, markdown. Trimmed, non-empty. */
export const longText = z.string().trim().min(1).max(10_000);

/**
 * Opaque pagination cursor token — string bounds only. The format check lives
 * in `pagination.ts` (`cursorTokenSchema`), which is what procedure inputs use.
 */
export const cursorToken = z.string().trim().min(1).max(128);

/**
 * Same-origin path only. Rejects protocol-relative (`//host`) and absolute
 * (`https://…`) URLs so a value we later hand to `location.assign` cannot
 * navigate the visitor off-site.
 *
 * A backslash is treated as a path separator here because the WHATWG URL
 * parser normalizes `\` to `/` for special schemes — so `/\evil.com` would
 * otherwise resolve to the protocol-relative `//evil.com`. Reject backslashes
 * (and ASCII control characters, which browsers strip before parsing) rather
 * than let either smuggle an off-site navigation past the `/`-prefix check.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally rejecting C0/DEL control chars that browsers strip pre-parse.
const CONTROL_OR_BACKSLASH = /[\\\u0000-\u001f\u007f]/;
export const pathOnlyUrl = z
  .string()
  .max(2000)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !value.includes("://") &&
      !CONTROL_OR_BACKSLASH.test(value),
    {
      message: "Must be a same-origin path starting with /",
    },
  );
