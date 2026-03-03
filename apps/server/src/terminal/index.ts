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
  const ptyProcess = pty.spawn(
    "opencode",
    ["attach", env.OPENCODE_URL ?? "http://opencode:4096"],
    {
      name: "xterm-256color",
      cols: 80,
      rows: 30,
      cwd: process.env.HOME,
      env: process.env as Record<string, string>,
    },
  );

  const sessionId = crypto.randomUUID();

  ptyProcess.onData((data) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
      session.ws.send(JSON.stringify({ type: "data", content: data }));
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
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
      session.pty.kill();
      session.ws.close();
      sessions.delete(id);
    }
  }
}, 60000);
