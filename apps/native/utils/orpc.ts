import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { SimpleCsrfProtectionLinkPlugin } from "@orpc/client/plugins";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouterClient } from "@starter/api/routers/index";
import { env } from "@starter/env/native";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { Platform } from "react-native";

import { authClient } from "@/lib/auth-client";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      console.log(error);
    },
  }),
});

// In-memory read-through cache for the Better-Auth session cookie.
// Better Auth 1.7 made `authClient.getCookie()` async (SecureStore reads are
// now awaited). Calling it inside `headers()` on every RPC would still hit
// SecureStore, so we cache the value and invalidate on `$sessionSignal`,
// which the Expo plugin notifies on every session-cookie change (sign-in,
// sign-out, OAuth) — and only *after* awaiting the SecureStore write, so a
// read-through after invalidation always sees the fresh cookie.
let cachedCookie: string | null | undefined;
authClient.$store.listen("$sessionSignal", () => {
  cachedCookie = undefined;
});

async function getSessionCookie(): Promise<string> {
  if (cachedCookie === undefined) {
    cachedCookie = await authClient.getCookie();
  }
  return cachedCookie ?? "";
}

const link = new RPCLink({
  url: `${env.EXPO_PUBLIC_SERVER_URL}/rpc`,
  plugins: [new SimpleCsrfProtectionLinkPlugin()],
  fetch: (url, options) =>
    fetch(url, {
      ...options,
      // Better Auth Expo forwards the session cookie manually on native.
      credentials: Platform.OS === "web" ? "include" : "omit",
    }),
  async headers() {
    if (Platform.OS === "web") {
      return {};
    }
    // Load-bearing per patterns/native.md: native has no browser-managed
    // cookies, so this manual Cookie forwarding is what makes authenticated
    // oRPC procedures work on iOS/Android. Never remove it.
    const headers = new Map<string, string>();
    const cookies = await getSessionCookie();
    if (cookies) {
      headers.set("Cookie", cookies);
    }
    return Object.fromEntries(headers);
  },
});

const client: AppRouterClient = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);

/**
 * Query options for the near-static `appConfig` procedure with a 5-minute
 * staleTime, so lazily-mounted tabs and app-foreground events don't refetch
 * server config that effectively never changes mid-session.
 */
export const appConfigQueryOptions = () => ({
  ...orpc.appConfig.queryOptions(),
  staleTime: 5 * 60_000,
});
