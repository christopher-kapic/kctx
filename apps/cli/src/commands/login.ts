import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { KCTX_URL } from "../constants.js";
import { saveSession } from "../session.js";

export const loginCommand = defineCommand({
  meta: { name: "login", description: "Log in to kinetic-context" },
  async run() {
    p.intro(pc.bgCyan(pc.black(" Login ")));

    const values = await p.group(
      {
        email: () =>
          p.text({
            message: "Email",
            validate: (v) => (v.length === 0 ? "Required" : undefined),
          }),
        password: () =>
          p.password({
            message: "Password",
            validate: (v) => (v.length === 0 ? "Required" : undefined),
          }),
      },
      {
        onCancel: () => {
          p.cancel("Cancelled.");
          process.exit(0);
        },
      },
    );

    const s = p.spinner();
    s.start("Logging in...");

    try {
      const res = await fetch(`${KCTX_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: values.email,
          password: values.password,
        }),
        redirect: "manual",
      });

      if (!res.ok && res.status !== 302) {
        const body = await res.text();
        throw new Error(`Login failed (${res.status}): ${body}`);
      }

      // Extract set-cookie header
      const setCookie = res.headers.getSetCookie();
      if (!setCookie || setCookie.length === 0) {
        throw new Error("No session cookie received from server");
      }

      // Combine all cookies into a single cookie header string
      const cookieStr = setCookie
        .map((c) => c.split(";")[0])
        .join("; ");

      saveSession(cookieStr);
      s.stop("Logged in!");
      p.log.success(`Connected to ${pc.cyan(KCTX_URL)}`);
    } catch (err) {
      s.stop("Login failed.", 1);
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    p.outro("Session saved to ~/.kctx/session.json");
  },
});
