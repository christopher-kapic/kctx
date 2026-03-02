import { homedir } from "node:os";
import { join } from "node:path";

export const KCTX_HOME = join(homedir(), ".kctx");
export const SESSION_FILE = join(KCTX_HOME, "session.json");
export const KCTX_URL =
  process.env.KCTX_URL || "http://localhost:7167";
export const API_BASE = `${KCTX_URL}/rpc`;
