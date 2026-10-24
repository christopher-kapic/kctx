import { useQuery } from "@tanstack/react-query";

import { orpc } from "@/utils/orpc";

/**
 * Whether this deployment can serve chat, for nav-rendering purposes.
 *
 * Returns `undefined` until the answer is known — callers must treat that as
 * "show it" rather than "hide it", so the common (enabled) deployment never
 * flashes a missing entry. See `chatEnabled` in `@/lib/nav-items`.
 *
 * `enabled: isAuthenticated` because `chat.config` is a protected procedure:
 * asking as a signed-out visitor is a guaranteed 401, and the nav does not
 * render the entry for them anyway.
 *
 * Cached hard. The value changes only when the server is redeployed with
 * different configuration, and every nav surface calls this — one query per
 * session, shared, rather than one per header render.
 */
export function useChatEnabled(isAuthenticated: boolean): boolean | undefined {
  const { data } = useQuery({
    ...orpc.chat.config.queryOptions(),
    enabled: isAuthenticated,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return data?.enabled;
}
