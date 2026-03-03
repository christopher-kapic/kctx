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
      console.log(`[terminal] PTY data (${data.length} chars): ${JSON.stringify(data.slice(0, 200))}`);
      session.ws.send(JSON.stringify({ type: "data", content: data }));
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
