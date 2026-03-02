import { env } from "@kctx/env/web";
import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";

const baseURL =
  env.VITE_SERVER_URL ??
  (typeof window !== "undefined" ? window.location.origin : "");

export const authClient = createAuthClient({
  baseURL,
  plugins: [adminClient()],
});
