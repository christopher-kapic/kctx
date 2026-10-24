import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { mountSecurityHeaders, s3ConnectSrcOrigins } from "./security-headers";

// Builds an app wired exactly like the real server: mountSecurityHeaders first,
// then the routes underneath it. This is an APP-LEVEL test on purpose — the
// raw-asset `sandbox` CSP only survives because of how mountSecurityHeaders
// orders its two middlewares relative to hono's `secureHeaders`. A handler-only
// test (asserting the header the asset route sets) passes even when the global
// middleware later clobbers it on the wire, which is the bug this guards.
function buildApp(cspConnectSrc: string[] = ["'self'"]) {
  const app = new Hono();
  mountSecurityHeaders(app, {
    cspConnectSrc,
    themeInitCspHash: "'sha256-test'",
  });
  app.get("/api/assets/:id", (c) => c.text("asset-bytes"));
  app.get("/some-page", (c) => c.text("page"));
  return app;
}

describe("mountSecurityHeaders", () => {
  it("serves /api/assets/:id with the sandbox CSP (not the app policy)", async () => {
    const res = await buildApp().request("/api/assets/abc123");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
  });

  it("serves non-asset routes with the app CSP, not sandbox", async () => {
    const res = await buildApp().request("/some-page");
    const csp = res.headers.get("content-security-policy");
    expect(csp).not.toBe("sandbox");
    expect(csp).toContain("default-src 'self'");
  });

  it("still applies the app CSP's other security headers to asset responses", async () => {
    // The sandbox override must replace only the CSP, leaving the rest of the
    // secureHeaders battery (e.g. X-Content-Type-Options) intact.
    const res = await buildApp().request("/api/assets/abc123");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("allows WASM compilation via 'wasm-unsafe-eval' without ever allowing 'unsafe-eval'", async () => {
    const res = await buildApp().request("/some-page");
    const csp = res.headers.get("content-security-policy") ?? "";
    // Token-split assertions: a substring check would false-positive on
    // 'unsafe-eval' being contained inside 'wasm-unsafe-eval'.
    const tokens = csp.split(/\s+/).map((t) => t.replace(/;$/, ""));
    expect(tokens).toContain("'wasm-unsafe-eval'");
    expect(tokens).not.toContain("'unsafe-eval'");
  });

  it("allows blob: workers via worker-src for the heic-to/csp decoder", async () => {
    const res = await buildApp().request("/some-page");
    const csp = res.headers.get("content-security-policy") ?? "";
    const workerSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("worker-src"));
    expect(workerSrc).toBeDefined();
    const tokens = (workerSrc ?? "").split(/\s+/);
    expect(tokens).toContain("'self'");
    expect(tokens).toContain("blob:");
    // blob: must stay confined to worker-src — never on script-src.
    const scriptSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src"));
    expect((scriptSrc ?? "").split(/\s+/)).not.toContain("blob:");
  });

  it("emits the S3 origin in connect-src when it is supplied", async () => {
    // The direct-to-S3 upload fetch (asset-client.ts) is
    // blocked by CSP unless the presigned URL's origin is in connect-src.
    const res = await buildApp(["'self'", "https://minio.example.com"]).request("/some-page");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self' https://minio.example.com");
  });
});

describe("s3ConnectSrcOrigins", () => {
  it("returns [] when the bucket is unset (S3 disabled) — policy unchanged", () => {
    expect(s3ConnectSrcOrigins({ bucket: "", region: "auto", forcePathStyle: false })).toEqual([]);
    expect(
      s3ConnectSrcOrigins({
        bucket: "",
        region: "us-east-1",
        endpoint: "https://minio.example.com",
        forcePathStyle: true,
      }),
    ).toEqual([]);
  });

  it("uses the endpoint origin for a path-style custom endpoint (MinIO)", () => {
    expect(
      s3ConnectSrcOrigins({
        bucket: "uploads",
        region: "us-east-1",
        endpoint: "https://minio.example.com:9000",
        forcePathStyle: true,
      }),
    ).toEqual(["https://minio.example.com:9000"]);
  });

  it("prepends the bucket for a virtual-hosted custom endpoint (R2)", () => {
    expect(
      s3ConnectSrcOrigins({
        bucket: "uploads",
        region: "auto",
        endpoint: "https://acct123.r2.cloudflarestorage.com",
        forcePathStyle: false,
      }),
    ).toEqual(["https://uploads.acct123.r2.cloudflarestorage.com"]);
  });

  it("builds the virtual-hosted AWS regional origin when no endpoint is set", () => {
    expect(
      s3ConnectSrcOrigins({ bucket: "uploads", region: "us-west-2", forcePathStyle: false }),
    ).toEqual(["https://uploads.s3.us-west-2.amazonaws.com"]);
  });

  // The bare regional origin is writable path-style by every AWS account, so it
  // must appear ONLY when the SDK will genuinely address this bucket that way —
  // never as a belt-and-braces addition alongside the virtual-hosted origin.
  it("never allows the bare regional origin alongside a virtual-hosted bucket", () => {
    expect(
      s3ConnectSrcOrigins({ bucket: "uploads", region: "us-west-2", forcePathStyle: false }),
    ).not.toContain("https://s3.us-west-2.amazonaws.com");
    expect(
      s3ConnectSrcOrigins({
        bucket: "uploads",
        region: "auto",
        endpoint: "https://acct123.r2.cloudflarestorage.com",
        forcePathStyle: false,
      }),
    ).not.toContain("https://acct123.r2.cloudflarestorage.com");
  });

  it.each([
    ["media.example.com", "a dot can't be a single DNS label"],
    ["Uploads", "uppercase is not DNS-label-safe"],
    ["ab", "shorter than 3 characters"],
    ["-uploads", "a leading hyphen is invalid"],
    ["uploads-", "a trailing hyphen is invalid"],
  ])("falls back to the bare regional origin for %s (%s)", (bucket) => {
    // These fail the SDK's isVirtualHostableS3Bucket check, so presigned PUTs go
    // to https://s3.<region>.amazonaws.com/<bucket>/… even with forcePathStyle
    // unset. Without the bare origin every upload is CSP-blocked in production
    // while working wherever the CSP is skipped.
    expect(s3ConnectSrcOrigins({ bucket, region: "us-east-1", forcePathStyle: false })).toEqual([
      "https://s3.us-east-1.amazonaws.com",
    ]);
  });

  it("falls back to the bare endpoint origin for a non-DNS-safe bucket on a custom endpoint", () => {
    expect(
      s3ConnectSrcOrigins({
        bucket: "media.example.com",
        region: "auto",
        endpoint: "https://acct123.r2.cloudflarestorage.com",
        forcePathStyle: false,
      }),
    ).toEqual(["https://acct123.r2.cloudflarestorage.com"]);
  });

  it("builds the path-style AWS regional origin when forcePathStyle is set", () => {
    expect(
      s3ConnectSrcOrigins({ bucket: "uploads", region: "eu-central-1", forcePathStyle: true }),
    ).toEqual(["https://s3.eu-central-1.amazonaws.com"]);
  });

  it("ignores a bucket key-prefix (only the bucket forms the host)", () => {
    // parseBucketSpec("shared/app-a").bucket === "shared"; the caller passes the
    // already-parsed bucket, so the prefix never reaches the origin.
    expect(
      s3ConnectSrcOrigins({ bucket: "shared", region: "us-east-1", forcePathStyle: false }),
    ).toEqual(["https://shared.s3.us-east-1.amazonaws.com"]);
  });
});
