import { describe, expect, it } from "vitest";

import { getNavDirection, getNavItems, stripLangPrefix, toLangRoute } from "./nav-items";

describe("nav-items", () => {
  it("returns public desktop items for signed-out visitors", () => {
    const items = getNavItems({
      placement: "desktop",
      isAuthenticated: false,
    }).map((item) => item.path);

    expect(items).toEqual(["/"]);
  });

  it("keeps public desktop items and adds app items for signed-in users", () => {
    const items = getNavItems({
      placement: "desktop",
      isAuthenticated: true,
      role: "user",
    }).map((item) => item.path);

    expect(items).toEqual(["/", "/dashboard", "/projects", "/chat", "/settings"]);
    expect(items).not.toContain("/admin");
  });

  it("adds admin destinations only when the shared admin role helper matches", () => {
    const nonAdminItems = getNavItems({
      placement: "desktop",
      isAuthenticated: true,
      role: "manager",
    }).map((item) => item.path);
    const adminItems = getNavItems({
      placement: "desktop",
      isAuthenticated: true,
      role: "user, admin",
    }).map((item) => item.path);

    expect(nonAdminItems).not.toContain("/admin");
    expect(adminItems).toContain("/admin");
  });

  it("keeps mobile navigation compact and role-aware", () => {
    const signedOutItems = getNavItems({
      placement: "mobile",
      isAuthenticated: false,
    }).map((item) => item.path);
    const adminItems = getNavItems({
      placement: "mobile",
      isAuthenticated: true,
      role: "admin",
    }).map((item) => item.path);

    expect(signedOutItems).toEqual(["/"]);
    expect(adminItems).toEqual(["/", "/dashboard", "/projects", "/chat", "/settings", "/admin"]);
  });

  it("derives user-menu destinations from the shared nav model", () => {
    const userItems = getNavItems({
      placement: "userMenu",
      isAuthenticated: true,
      role: "user",
    }).map((item) => item.path);
    const adminItems = getNavItems({
      placement: "userMenu",
      isAuthenticated: true,
      role: "admin",
    }).map((item) => item.path);

    expect(userItems).toEqual(["/settings"]);
    expect(adminItems).toEqual(["/settings", "/admin"]);
  });

  // Regression guard. Every authenticated app route belongs in this registry —
  // it is what renders the desktop header and the mobile bottom bar, so a route
  // that is missing from it ships unreachable except by typing its URL.
  it("exposes the chat route to signed-in users on desktop and mobile", () => {
    for (const placement of ["desktop", "mobile"] as const) {
      expect(
        getNavItems({ placement, isAuthenticated: true, role: "user" }).map((item) => item.path),
      ).toContain("/chat");
    }
    expect(
      getNavItems({ placement: "desktop", isAuthenticated: false }).map((item) => item.path),
    ).not.toContain("/chat");
  });

  // Same regression guard, for the golden-path example feature: a route that is
  // missing from this registry ships unreachable except by typing its URL.
  // Unlike chat it has no server-side enablement flag, so it is visible to every
  // signed-in visitor and to no anonymous one.
  it("exposes the projects route to signed-in users on desktop and mobile", () => {
    for (const placement of ["desktop", "mobile"] as const) {
      expect(
        getNavItems({ placement, isAuthenticated: true, role: "user" }).map((item) => item.path),
      ).toContain("/projects");
    }
    expect(
      getNavItems({ placement: "desktop", isAuthenticated: false }).map((item) => item.path),
    ).not.toContain("/projects");
  });

  it("builds typed locale-prefixed routes", () => {
    expect(toLangRoute("/")).toBe("/$lang");
    expect(toLangRoute("/dashboard")).toBe("/$lang/dashboard");
    expect(toLangRoute("/projects")).toBe("/$lang/projects");
    expect(toLangRoute("/chat")).toBe("/$lang/chat");
  });

  it("returns forward for later items in the composed app nav list", () => {
    expect(getNavDirection("/", "/dashboard")).toBe("forward");
    expect(getNavDirection("/dashboard", "/settings")).toBe("forward");
  });

  it("returns back for earlier items in the composed app nav list", () => {
    expect(getNavDirection("/settings", "/dashboard")).toBe("back");
    expect(getNavDirection("/settings", "/")).toBe("back");
  });

  it("returns none for same-path navigation", () => {
    expect(getNavDirection("/settings", "/settings")).toBe("none");
  });

  it("returns forward for off-nav child routes", () => {
    expect(getNavDirection("/settings", "/settings/privacy")).toBe("forward");
  });

  it("returns back from child routes to their parent", () => {
    expect(getNavDirection("/settings/privacy", "/settings")).toBe("back");
  });

  it("returns back when moving left across settings sub-nav siblings", () => {
    expect(getNavDirection("/settings/security", "/settings")).toBe("back");
  });

  it("returns forward when moving right across settings sub-nav siblings", () => {
    expect(getNavDirection("/settings", "/settings/security")).toBe("forward");
  });

  it("defaults unrelated routes to forward", () => {
    expect(getNavDirection("/dashboard", "/login")).toBe("forward");
  });

  it("strips the locale prefix from top-level routes", () => {
    expect(stripLangPrefix("/en-US/dashboard")).toBe("/dashboard");
  });

  it("returns root when only the locale segment is present", () => {
    expect(stripLangPrefix("/en-US")).toBe("/");
    expect(stripLangPrefix("/en-US/")).toBe("/");
  });

  it("preserves nested segments after stripping the locale prefix", () => {
    expect(stripLangPrefix("/en-US/settings/privacy")).toBe("/settings/privacy");
  });
  // A deployment without `CHAT_ENABLED` + `OPENROUTER_API_KEY` has no
  // conversation to offer, so it should not advertise one. Hiding the entry is
  // tidiness, never a security control — the procedures refuse regardless.
  it("drops the chat entry when the server reports chat disabled", () => {
    const paths = getNavItems({
      placement: "desktop",
      isAuthenticated: true,
      chatEnabled: false,
    }).map((item) => item.path);
    expect(paths).not.toContain("/chat");
    // Everything else is untouched.
    expect(paths).toContain("/dashboard");
  });

  // UNDEFINED MEANS SHOW IT: the enabled deployment is the common one, so
  // treating "not yet known" as disabled would pop the entry into every nav on
  // every cold load.
  it("keeps the chat entry while enablement is still unknown", () => {
    for (const chatEnabled of [undefined, true]) {
      const paths = getNavItems({ placement: "desktop", isAuthenticated: true, chatEnabled }).map(
        (item) => item.path,
      );
      expect(paths).toContain("/chat");
    }
  });
});
