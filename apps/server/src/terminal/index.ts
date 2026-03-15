import * as pty from "node-pty";
import type { WSContext } from "hono/ws";
import { env } from "@kctx/env/server";

export interface TerminalSession {
  id: string;
  pty: pty.IPty;
  userId: string;
  lastActivity: Date;
  ws: WSContext;
}

const sessions = new Map<string, TerminalSession>();

const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Strip DECRQM (request mode) sequences that crash xterm.js 6.0.0's minified bundle.
// OpenCode sends these to probe terminal capabilities; it falls back gracefully without responses.
const DECRQM_RE = /\x1b\[\??\d+\$p/g;

// Match OSC 52 clipboard sequences: ESC ] 52 ; <target> ; <base64> BEL/ST
// Also handles tmux passthrough wrapping: ESC Ptmux; ESC <osc52> ESC \
const OSC52_RE = /(?:\x1bPtmux;\x1b)?\x1b\]52;[a-z]*;([A-Za-z0-9+/=]*)\x07(?:\x1b\\)?/g;

interface SanitizeResult {
  data: string;
  clipboardText?: string;
}

function sanitizePtyOutput(data: string): SanitizeResult {
  // Extract OSC 52 clipboard content before stripping
  let clipboardText: string | undefined;
  const osc52Match = OSC52_RE.exec(data);
  if (osc52Match?.[1]) {
    try {
      clipboardText = Buffer.from(osc52Match[1], "base64").toString("utf-8");
    } catch {
      // Invalid base64, ignore
    }
  }
  OSC52_RE.lastIndex = 0; // Reset regex state

  const cleaned = data.replace(OSC52_RE, "").replace(DECRQM_RE, "");
  return { data: cleaned, clipboardText };
}

export function createSession(userId: string, ws: WSContext): string {
  const openCodeUrl = env.OPENCODE_URL ?? "http://opencode:4096";
  console.log(`[terminal] Creating session for user ${userId}`);
  console.log(`[terminal] Spawning: opencode attach ${openCodeUrl}`);

  const ptyProcess = pty.spawn(
    "opencode",
    ["attach", openCodeUrl],
    {
      name: "xterm-256color",
      cols: 80,
      rows: 30,
      cwd: process.env.HOME,
      env: process.env as Record<string, string>,
    },
  );

  const sessionId = crypto.randomUUID();
  console.log(`[terminal] Session ${sessionId} created, PTY pid: ${ptyProcess.pid}`);

  ptyProcess.onData((data) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
      const result = sanitizePtyOutput(data);

      // Forward clipboard content as a separate message so the browser can
      // write it to the user's system clipboard via the Clipboard API.
      if (result.clipboardText) {
        session.ws.send(JSON.stringify({ type: "clipboard", text: result.clipboardText }));
      }

      if (result.data.length === 0) return;
      console.log(`[terminal] PTY data (${result.data.length} chars): ${JSON.stringify(result.data.slice(0, 200))}`);
      session.ws.send(JSON.stringify({ type: "data", content: result.data }));
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[terminal] Session ${sessionId} PTY exited with code ${exitCode}`);
    const session = sessions.get(sessionId);
    if (session) {
      session.ws.send(JSON.stringify({ type: "exit", code: exitCode }));
      sessions.delete(sessionId);
    }
  });

  sessions.set(sessionId, {
    id: sessionId,
    pty: ptyProcess,
    userId,
    lastActivity: new Date(),
    ws,
  });

  return sessionId;
}

export function resizeSession(sessionId: string, cols: number, rows: number) {
  console.log(`[terminal] Resize session ${sessionId}: ${cols}x${rows}`);
  sessions.get(sessionId)?.pty.resize(cols, rows);
}

export function writeToSession(sessionId: string, data: string) {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastActivity = new Date();
    session.pty.write(data);
  }
}

export function closeSession(sessionId: string) {
  console.log(`[terminal] Closing session ${sessionId}`);
  const session = sessions.get(sessionId);
  if (session) {
    session.pty.kill();
    sessions.delete(sessionId);
  }
}

export function getSessions(userId: string) {
  return Array.from(sessions.values())
    .filter((s) => s.userId === userId)
    .map((s) => ({ id: s.id, lastActivity: s.lastActivity }));
}

// Cleanup interval for idle sessions
setInterval(() => {
  const now = new Date();
  for (const [id, session] of sessions) {
    if (now.getTime() - session.lastActivity.getTime() > TIMEOUT_MS) {
      console.log(`[terminal] Session ${id} timed out, cleaning up`);
      session.pty.kill();
      session.ws.close();
      sessions.delete(id);
    }
  }
}, 60000);
