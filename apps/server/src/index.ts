import { StreamableHTTPTransport } from "@hono/mcp";
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
import {
  authenticateApiKey,
  createMcpServer,
  mcpContextStorage,
} from "./mcp/index.js";

const app = new Hono();

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

// MCP Server setup
const mcpServer = createMcpServer();
const mcpTransport = new StreamableHTTPTransport();

let mcpConnected = false;
async function ensureMcpConnected() {
  if (!mcpConnected) {
    await mcpServer.connect(mcpTransport);
    mcpConnected = true;
  }
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

serve(
  {
    fetch: app.fetch,
    port: 3000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);
