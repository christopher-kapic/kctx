import fs from "node:fs";
import { KCTX_HOME, SESSION_FILE } from "./constants.js";

interface StoredSession {
  cookie: string;
}

export function saveSession(cookie: string): void {
  fs.mkdirSync(KCTX_HOME, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ cookie }), {
    mode: 0o600,
  });
}

export function loadSession(): StoredSession | null {
  try {
    const raw = fs.readFileSync(SESSION_FILE, "utf-8");
    const data = JSON.parse(raw) as StoredSession;
    if (data.cookie) return data;
    return null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch {
    // File may not exist
  }
}

export function getSessionCookie(): string {
  const session = loadSession();
  if (!session) {
    throw new Error(
      "Not logged in. Run 'kctx login' first.",
    );
  }
  return session.cookie;
}
