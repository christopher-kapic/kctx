import { Readable } from "node:stream";
import type { Session } from "@starter/auth";
import type { Env } from "hono";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAssetRead: vi.fn(),
  readAssetObject: vi.fn(),
  streamAssetObject: vi.fn(),
  presignAsset: vi.fn(),
  finalizeAsset: vi.fn(),
  heartbeatAsset: vi.fn(),
  analyzeAssetQueueAdd: vi.fn(),
  lookup: vi.fn(),
  httpsRequest: vi.fn(),
  httpRequest: vi.fn(),
  transformImage: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  lookup: mocks.lookup,
}));

vi.mock("node:https", () => ({ request: mocks.httpsRequest }));
vi.mock("node:http", () => ({ request: mocks.httpRequest }));

// Build a fake IncomingMessage: a Readable carrying the body, tagged with the
// statusCode/headers the proxy reads. Mirrors what node:https.request yields.
function fakeUpstream(opts: {
  status: number;
  headers?: Record<string, string>;
  body?: number[] | null;
}): Readable {
  const res = Readable.from(opts.body ? [Buffer.from(opts.body)] : []) as Readable & {
    statusCode?: number;
    headers?: Record<string, string>;
  };
  res.statusCode = opts.status;
  res.headers = opts.headers ?? {};
  return res;
}

function mockUpstream(opts: Parameters<typeof fakeUpstream>[0]) {
  mocks.httpsRequest.mockImplementation(
    (_url: unknown, _options: unknown, callback: (res: Readable) => void) => {
      queueMicrotask(() => callback(fakeUpstream(opts)));
      return { on: vi.fn(), end: vi.fn() };
    },
  );
}

vi.mock("@starter/api/lib/assets", () => ({
  AssetError: class AssetError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
      this.name = "AssetError";
    }
  },
  assetCacheControl: (visibility: string) =>
    visibility === "PUBLIC" ? "public, max-age=86400, immutable" : "private, no-cache",
  authorizeAssetRead: mocks.authorizeAssetRead,
  readAssetObject: mocks.readAssetObject,
  streamAssetObject: mocks.streamAssetObject,
  finalizeAsset: mocks.finalizeAsset,
  heartbeatAsset: mocks.heartbeatAsset,
  presignAsset: mocks.presignAsset,
}));

vi.mock("@starter/api/lib/images", () => ({
  imageTransformETag: (assetId: string) => `"img:${assetId}:w0:h0:q80:webp"`,
  parseTransformParams: () => ({}),
  transformImage: mocks.transformImage,
}));

vi.mock("@starter/api/lib/storage", () => ({
  storage: {},
}));

vi.mock("@starter/env/server", () => ({
  env: {
    ASSET_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
    IMAGE_PROXY_ALLOWED_HOSTS: "allowed.example",
    IMAGE_PROXY_TIMEOUT_MS: 5000,
    IMAGE_PROXY_MAX_BYTES: 10 * 1024 * 1024,
  },
}));

vi.mock("@starter/queue", () => ({
  analyzeAssetQueue: { add: mocks.analyzeAssetQueueAdd },
}));

const { mountAssetRoutes } = await import("./asset-routes.js");

type TestEnv = Env & { Variables: { session: Session | null } };

describe("asset routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lookup.mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);
    mocks.transformImage.mockResolvedValue({
      body: Buffer.from([1, 2, 3]),
      contentType: "image/webp",
    });
    mockUpstream({
      status: 200,
      headers: { "content-type": "image/png", "content-length": "3" },
      body: [1, 2, 3],
    });
  });

  it("sandboxes and downloads non-raster raw assets", async () => {
    const app = new Hono<TestEnv>();
    mountAssetRoutes(app);

    mocks.authorizeAssetRead.mockResolvedValue(
      makeAssetMeta({ mimeType: "text/html", visibility: "PUBLIC" }),
    );
    mocks.streamAssetObject.mockResolvedValue(
      makeStreamBody(new TextEncoder().encode("<script>alert(1)</script>"), "text/html"),
    );

    const res = await app.request("/api/assets/asset-1");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html");
    expect(res.headers.get("Content-Disposition")).toBe("attachment");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(await res.text()).toBe("<script>alert(1)</script>");
  });

  it("allows known raster images to render inline", async () => {
    const app = new Hono<TestEnv>();
    mountAssetRoutes(app);

    mocks.authorizeAssetRead.mockResolvedValue(
      makeAssetMeta({ mimeType: "image/png", visibility: "PUBLIC" }),
    );
    mocks.streamAssetObject.mockResolvedValue(
      makeStreamBody(new Uint8Array([1, 2, 3]), "image/png"),
    );

    const res = await app.request("/api/assets/asset-1");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
  });

  it("answers a matching If-None-Match with 304 without reading storage", async () => {
    const app = new Hono<TestEnv>();
    mountAssetRoutes(app);

    mocks.authorizeAssetRead.mockResolvedValue(
      makeAssetMeta({ mimeType: "image/png", visibility: "PUBLIC" }),
    );

    const res = await app.request("/api/assets/asset-1", {
      headers: { "If-None-Match": '"asset-1"' },
    });

    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe('"asset-1"');
    expect(mocks.streamAssetObject).not.toHaveBeenCalled();
    // Authorization always runs before the conditional short-circuit.
    expect(mocks.authorizeAssetRead).toHaveBeenCalled();
  });

  it("404s an If-None-Match probe for an asset the viewer cannot read (no 304 oracle)", async () => {
    const app = new Hono<TestEnv>();
    mountAssetRoutes(app);

    const { AssetError } = await import("@starter/api/lib/assets");
    mocks.authorizeAssetRead.mockRejectedValue(new AssetError("FORBIDDEN", "Not allowed"));

    const res = await app.request("/api/assets/asset-1", {
      headers: { "If-None-Match": '"asset-1"' },
    });

    expect(res.status).toBe(404);
    expect(mocks.streamAssetObject).not.toHaveBeenCalled();
  });

  it("answers a matching If-None-Match on the image endpoint with 304 before S3/sharp", async () => {
    const app = new Hono<TestEnv>();
    mountAssetRoutes(app);

    mocks.authorizeAssetRead.mockResolvedValue(
      makeAssetMeta({ mimeType: "image/png", visibility: "PUBLIC" }),
    );

    const res = await app.request("/api/images/asset-1", {
      headers: { "If-None-Match": '"img:asset-1:w0:h0:q80:webp"' },
    });

    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe('"img:asset-1:w0:h0:q80:webp"');
    expect(mocks.readAssetObject).not.toHaveBeenCalled();
    expect(mocks.transformImage).not.toHaveBeenCalled();
  });

  it("transforms and tags internal images with the transform ETag", async () => {
    const app = new Hono<TestEnv>();
    mountAssetRoutes(app);

    mocks.authorizeAssetRead.mockResolvedValue(
      makeAssetMeta({ mimeType: "image/png", visibility: "PUBLIC" }),
    );
    mocks.readAssetObject.mockResolvedValue({
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
      contentLength: 3,
    });

    const res = await app.request("/api/images/asset-1");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("ETag")).toBe('"img:asset-1:w0:h0:q80:webp"');
  });

  it("rejects active document MIME types during presign", async () => {
    const app = new Hono<TestEnv>();
    app.use("*", async (c, next) => {
      c.set("session", { user: { id: "user-1" } } as Session);
      await next();
    });
    mountAssetRoutes(app);

    const res = await app.request("/api/assets/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mimeType: "image/svg+xml",
        size: 1024,
        visibility: "PUBLIC",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That file type isn't allowed." });
    expect(mocks.presignAsset).not.toHaveBeenCalled();
  });

  it("does not follow redirects from external image proxy sources", async () => {
    const app = new Hono<TestEnv>();
    mountAssetRoutes(app);
    mockUpstream({
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
      body: null,
    });

    const res = await app.request(externalImagePath("https://allowed.example/redirect.png"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Image proxy redirects are not allowed." });
    // The outbound request pins DNS via a lookup hook so the socket can't
    // re-resolve to a private IP after the SSRF check.
    expect(mocks.httpsRequest).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ method: "GET", lookup: expect.any(Function) }),
      expect.any(Function),
    );
  });

  it("blocks allowlisted external image hosts that resolve to private addresses", async () => {
    const app = new Hono<TestEnv>();
    mountAssetRoutes(app);
    mocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    const res = await app.request(externalImagePath("https://allowed.example/image.png"));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "That image host isn't allowed." });
    // The host is rejected before any connection is attempted.
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it("blocks when one of several resolved addresses is private (round-robin rebind)", async () => {
    const app = new Hono<TestEnv>();
    mountAssetRoutes(app);
    mocks.lookup.mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);

    const res = await app.request(externalImagePath("https://allowed.example/image.png"));

    expect(res.status).toBe(403);
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it("pins the validated address via the request lookup hook", async () => {
    const app = new Hono<TestEnv>();
    mountAssetRoutes(app);
    mocks.lookup.mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);

    await app.request(externalImagePath("https://allowed.example/image.png"));

    const lookupHook = mocks.httpsRequest.mock.calls[0]?.[1]?.lookup as (
      hostname: string,
      options: unknown,
      cb: (err: unknown, address: string, family: number) => void,
    ) => void;
    expect(lookupHook).toBeTypeOf("function");
    const single = vi.fn();
    lookupHook("allowed.example", { all: false }, single);
    expect(single).toHaveBeenCalledWith(null, "203.0.113.10", 4);
  });

  it("proxies allowlisted external images when DNS resolves publicly", async () => {
    const app = new Hono<TestEnv>();
    mountAssetRoutes(app);

    const res = await app.request(externalImagePath("https://allowed.example/image.png"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(mocks.transformImage).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), {});
  });
});

function makeAssetMeta(overrides: { mimeType: string; visibility: "PUBLIC" | "RESTRICTED" }) {
  return {
    id: "asset-1",
    storageKey: "assets/asset-1",
    mimeType: overrides.mimeType,
    size: 3,
    visibility: overrides.visibility,
    ownerId: null,
    width: null,
    height: null,
    blurhash: null,
    status: "READY",
    metadataState: "SERVER_VERIFIED",
  };
}

/** Mimic the StorageObjectRange shape streamAssetObject resolves with. */
function makeStreamBody(bytes: Uint8Array, contentType: string) {
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    contentType,
    contentLength: bytes.byteLength,
    contentRange: null,
    totalSize: bytes.byteLength,
    etag: null,
  };
}

function externalImagePath(url: string): string {
  return `/api/images/${encodeURIComponent(url)}`;
}
