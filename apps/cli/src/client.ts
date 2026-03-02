import type { AppRouterClient } from "@kctx/api/routers/index";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { API_BASE } from "./constants.js";
import { getSessionCookie } from "./session.js";

const link = new RPCLink({
  url: API_BASE,
  headers() {
    const cookie = getSessionCookie();
    return { Cookie: cookie };
  },
});

export const client: AppRouterClient = createORPCClient(link);
