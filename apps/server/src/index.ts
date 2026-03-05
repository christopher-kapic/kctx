import { StreamableHTTPTransport } from "@hono/mcp";
import { createNodeWebSocket } from "@hono/node-ws";
import { createContext } from "@kctx/api/context";
import { appRouter } from "@kctx/api/routers/index";
import { auth } from "@kctx/auth";
import prisma from "@kctx/db";
import { env } from "@kctx/env/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import sharp from "sharp";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  authenticateApiKey,
  createMcpServer,
  mcpContextStorage,
} from "./mcp/index.js";
import {
  createSession,
  writeToSession,
  closeSession,
  resizeSession,
  getSessions,
} from "./terminal/index.js";

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use(logger());
if (env.CORS_ORIGIN) {
  app.use(
    "/*",
    cors({
      origin: env.CORS_ORIGIN,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }),
  );
}

// Block signups when disabled (but always allow if 0 users exist)
app.on(["POST"], "/api/auth/sign-up/*", async (c, next) => {
  const userCount = await prisma.user.count();
  if (userCount === 0) {
    return next();
  }
  const settings = await prisma.siteSettings
    .findUnique({ where: { id: "default" } })
    .then((s) => s ?? { signupsEnabled: true });
  if (!settings.signupsEnabled) {
    return c.json({ error: "Signups are currently disabled" }, 403);
  }
  return next();
});

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Package image upload
app.post("/api/packages/:id/image", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const packageId = c.req.param("id");
  const pkg = await prisma.package.findUnique({ where: { id: packageId } });
  if (!pkg) return c.json({ error: "Package not found" }, 404);

  const body = await c.req.parseBody();
  const file = body["image"];
  if (!(file instanceof File)) return c.json({ error: "No image file provided" }, 400);

  const buffer = Buffer.from(await file.arrayBuffer());
  const resized = await sharp(buffer)
    .resize(256, 256, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();

  const imagesDir = join(env.PACKAGES_PATH, "_images");
  mkdirSync(imagesDir, { recursive: true });
  await writeFile(join(imagesDir, `${packageId}.png`), resized);

  return c.json({ success: true });
});

// Package image serve
app.get("/api/packages/:id/image", async (c) => {
  const packageId = c.req.param("id");
  const imagePath = join(env.PACKAGES_PATH, "_images", `${packageId}.png`);

  if (!existsSync(imagePath)) return c.notFound();

  const data = await readFile(imagePath);
  return c.newResponse(data, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=3600",
    },
  });
});

// Terminal session management REST endpoints
app.get("/api/terminal/sessions", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user || session.user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  return c.json(getSessions(session.user.id));
});

app.delete("/api/terminal/sessions/:id", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user || session.user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  closeSession(c.req.param("id"));
  return c.json({ success: true });
});

// WebSocket endpoint for terminal
app.get(
  "/ws/terminal",
  upgradeWebSocket(async (c) => {
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });

    if (!session?.user || session.user.role !== "admin") {
      return {};
    }

    let sessionId: string | null = c.req.query("sessionId") ?? null;

    return {
      onOpen(_event, ws) {
        if (!sessionId) {
          sessionId = createSession(session.user.id, ws);
          ws.send(JSON.stringify({ type: "session", id: sessionId }));
        }
      },
      onMessage(event, _ws) {
        if (!sessionId) return;
        const msg = JSON.parse(
          typeof event.data === "string" ? event.data : "",
        );
        if (msg.type === "resize") {
          resizeSession(sessionId, msg.cols, msg.rows);
        } else if (msg.type === "input") {
          writeToSession(sessionId, msg.data);
        }
      },
      onClose() {
        if (sessionId) {
          closeSession(sessionId);
        }
      },
    };
  }),
);

// MCP Server setup
const mcpServerPromise = createMcpServer();
const mcpTransport = new StreamableHTTPTransport();

let mcpConnectPromise: Promise<void> | null = null;
function ensureMcpConnected() {
  if (!mcpConnectPromise) {
    mcpConnectPromise = mcpServerPromise.then((server) => server.connect(mcpTransport));
  }
  return mcpConnectPromise;
}

// MCP endpoint — authenticated via API key
app.all("/mcp", async (c) => {
  const authResult = await authenticateApiKey(c.req.header("Authorization"));

  if (!authResult) {
    return c.json({ error: "Invalid or revoked API key" }, 401);
  }

  await ensureMcpConnected();
  return mcpContextStorage.run(authResult, () =>
    mcpTransport.handleRequest(c),
  );
});

export const apiHandler = new OpenAPIHandler(appRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
    }),
  ],
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

export const rpcHandler = new RPCHandler(appRouter, {
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

app.use("/*", async (c, next) => {
  const context = await createContext({ context: c });

  const rpcResult = await rpcHandler.handle(c.req.raw, {
    prefix: "/rpc",
    context: context,
  });

  if (rpcResult.matched) {
    return c.newResponse(rpcResult.response.body, rpcResult.response);
  }

  const apiResult = await apiHandler.handle(c.req.raw, {
    prefix: "/api-reference",
    context: context,
  });

  if (apiResult.matched) {
    return c.newResponse(apiResult.response.body, apiResult.response);
  }

  await next();
});

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

if (process.env.NODE_ENV === "production") {
  // Serve static assets from the Vite build output
  // serveStatic resolves relative to CWD (apps/server/ in production)
  app.use("/*", serveStatic({ root: "../web/dist/" }));

  // SPA fallback: serve index.html for all unmatched routes
  const indexHtml = readFileSync(
    resolve(process.cwd(), "../web/dist/index.html"),
    "utf-8",
  );

  app.get("/*", (c) => {
    return c.html(indexHtml);
  });
} else {
  // Development: just return OK for the root route
  app.get("/", (c) => {
    return c.text("OK");
  });
}

const server = serve(
  {
    fetch: app.fetch,
    port: 3000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);

injectWebSocket(server);
