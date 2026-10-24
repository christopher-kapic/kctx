import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AssetMetaRow } from "./assets";

vi.mock("@starter/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

vi.mock("@starter/env/server", () => ({
  env: {},
  ADMIN_EMAILS: new Set<string>(),
}));

// Stub storage so the lib sees a non-null `storage` and the helpers we call
// are intercepted before they reach the real S3 client.
vi.mock("./storage", () => {
  return {
    storage: { bucket: "test-bucket", client: {} },
    presignPut: vi.fn(),
    headStorageObject: vi.fn(),
    getStorageObject: vi.fn(),
    putStorageObject: vi.fn(),
    deleteStorageObject: vi.fn(),
    readStorageObjectPrefix: vi.fn(),
  };
});

vi.mock("./images", () => ({
  analyzeImage: vi.fn(),
}));

const { default: prisma } = await import("@starter/db");
const storageModule = await import("./storage");
const {
  AssetError,
  analyzeStoredAsset,
  assetMetaSelect,
  authorizeAssetRead,
  createAsset,
  finalizeAsset,
  heartbeatAsset,
  presignAsset,
  updateAssetMetadata,
} = await import("./assets");

const db = prisma as unknown as {
  asset: {
    create: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
  };
};

const presignPutMock = storageModule.presignPut as unknown as MockInstance;
const headMock = storageModule.headStorageObject as unknown as MockInstance;
const prefixMock = storageModule.readStorageObjectPrefix as unknown as MockInstance;

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const HTML_BYTES = new Uint8Array(
  [..."<html><script>alert(1)</script></html>"].map((c) => c.charCodeAt(0)),
);

function makeRow(overrides: Partial<AssetMetaRow> = {}): AssetMetaRow {
  return {
    id: "asset-1",
    storageKey: "assets/abc",
    mimeType: "image/png",
    size: 1024n,
    visibility: "RESTRICTED",
    ownerId: "user-1",
    width: 100,
    height: 100,
    blurhash: "L00",
    status: "PENDING",
    metadataState: "CLIENT_HINT",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("presignAsset", () => {
  it("creates a PENDING row with the client-supplied hint and returns the signed URL", async () => {
    presignPutMock.mockResolvedValue({
      url: "https://s3.example/signed",
      headers: { "Content-Type": "image/png", "Content-Length": "1024" },
      expiresIn: 300,
    });
    db.asset.create.mockResolvedValue(makeRow());

    const result = await presignAsset({
      mimeType: "image/png",
      size: 1024,
      visibility: "RESTRICTED",
      ownerId: "user-1",
      hint: { width: 100, height: 100, blurhash: "L00" },
    });

    expect(result.assetId).toBe("asset-1");
    expect(result.upload.url).toBe("https://s3.example/signed");
    expect(db.asset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PENDING",
          metadataState: "CLIENT_HINT",
          width: 100,
          height: 100,
          blurhash: "L00",
        }),
      }),
    );
  });

  it("nulls missing hint fields rather than persisting undefined", async () => {
    presignPutMock.mockResolvedValue({ url: "u", headers: {}, expiresIn: 300 });
    db.asset.create.mockResolvedValue(makeRow({ width: null, height: null, blurhash: null }));

    await presignAsset({
      mimeType: "application/pdf",
      size: 50,
      visibility: "PUBLIC",
      ownerId: "user-1",
    });

    expect(db.asset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ width: null, height: null, blurhash: null }),
      }),
    );
  });
});

describe("asset metadata query projections", () => {
  it("selects the metadata boundary when authorizing a read", async () => {
    db.asset.findUnique.mockResolvedValue(makeRow({ visibility: "PUBLIC" }));

    await authorizeAssetRead("asset-1", { kind: "anonymous" });

    expect(db.asset.findUnique).toHaveBeenCalledWith({
      where: { id: "asset-1" },
      select: assetMetaSelect,
    });
  });

  it("selects the metadata boundary from createAsset", async () => {
    db.asset.create.mockResolvedValue(makeRow({ status: "READY" }));

    await createAsset({
      body: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      visibility: "RESTRICTED",
      ownerId: "user-1",
    });

    expect(db.asset.create).toHaveBeenCalledWith(
      expect.objectContaining({ select: assetMetaSelect }),
    );
  });

  it("selects the metadata boundary from updateAssetMetadata", async () => {
    db.asset.update.mockResolvedValue(makeRow({ status: "READY" }));

    await updateAssetMetadata("asset-1", { width: 200 });

    expect(db.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ select: assetMetaSelect }),
    );
  });

  it("selects the metadata boundary before analyzeStoredAsset maps the row", async () => {
    db.asset.findUnique.mockResolvedValue(makeRow({ status: "PENDING" }));

    await analyzeStoredAsset("asset-1");

    expect(db.asset.findUnique).toHaveBeenCalledWith({
      where: { id: "asset-1" },
      select: assetMetaSelect,
    });
  });
});

describe("finalizeAsset", () => {
  const viewer = { kind: "user" as const, userId: "user-1", role: "user" };

  it("flips status to READY when HEAD confirms the object", async () => {
    db.asset.findUnique.mockResolvedValue(makeRow());
    headMock.mockResolvedValue({ contentLength: 1024, contentType: "image/png" });
    prefixMock.mockResolvedValue(PNG_MAGIC);
    db.asset.update.mockResolvedValue(makeRow({ status: "READY" }));

    const meta = await finalizeAsset({ assetId: "asset-1", viewer });

    expect(meta.status).toBe("READY");
    expect(db.asset.update).toHaveBeenCalledWith({
      where: { id: "asset-1" },
      data: { status: "READY" },
      select: assetMetaSelect,
    });
    expect(db.asset.findUnique).toHaveBeenCalledWith({
      where: { id: "asset-1" },
      select: assetMetaSelect,
    });
  });

  it("is idempotent on already-READY rows (no HEAD, no update)", async () => {
    db.asset.findUnique.mockResolvedValue(makeRow({ status: "READY" }));

    const meta = await finalizeAsset({ assetId: "asset-1", viewer });

    expect(meta.status).toBe("READY");
    expect(headMock).not.toHaveBeenCalled();
    expect(db.asset.update).not.toHaveBeenCalled();
  });

  it("throws UPLOAD_MISSING when HEAD returns null", async () => {
    db.asset.findUnique.mockResolvedValue(makeRow());
    headMock.mockResolvedValue(null);

    await expect(finalizeAsset({ assetId: "asset-1", viewer })).rejects.toMatchObject({
      name: "AssetError",
      code: "UPLOAD_MISSING",
    });
    expect(db.asset.update).not.toHaveBeenCalled();
  });

  it("throws SIZE_MISMATCH when stored size differs from presigned size", async () => {
    db.asset.findUnique.mockResolvedValue(makeRow({ size: 1024n }));
    headMock.mockResolvedValue({ contentLength: 999, contentType: "image/png" });

    await expect(finalizeAsset({ assetId: "asset-1", viewer })).rejects.toMatchObject({
      name: "AssetError",
      code: "SIZE_MISMATCH",
    });
  });

  it("404s a non-owner caller (presence is not leaked)", async () => {
    db.asset.findUnique.mockResolvedValue(makeRow({ ownerId: "someone-else" }));

    await expect(
      finalizeAsset({
        assetId: "asset-1",
        viewer: { kind: "user", userId: "user-1", role: "user" },
      }),
    ).rejects.toMatchObject({ name: "AssetError", code: "NOT_FOUND" });
    expect(headMock).not.toHaveBeenCalled();
  });

  it("admin can finalize an asset they don't own", async () => {
    db.asset.findUnique.mockResolvedValue(makeRow({ ownerId: "someone-else" }));
    headMock.mockResolvedValue({ contentLength: 1024, contentType: "image/png" });
    prefixMock.mockResolvedValue(PNG_MAGIC);
    db.asset.update.mockResolvedValue(makeRow({ ownerId: "someone-else", status: "READY" }));

    const meta = await finalizeAsset({
      assetId: "asset-1",
      viewer: { kind: "user", userId: "admin-1", role: "admin" },
    });
    expect(meta.status).toBe("READY");
  });

  it("throws NOT_FOUND for an unknown asset id", async () => {
    db.asset.findUnique.mockResolvedValue(null);
    await expect(finalizeAsset({ assetId: "missing", viewer })).rejects.toMatchObject({
      name: "AssetError",
      code: "NOT_FOUND",
    });
  });

  it("rejects HTML bytes labeled image/png with MIME_MISMATCH and leaves the row PENDING", async () => {
    db.asset.findUnique.mockResolvedValue(makeRow({ mimeType: "image/png" }));
    headMock.mockResolvedValue({ contentLength: 1024, contentType: "image/png" });
    prefixMock.mockResolvedValue(HTML_BYTES);

    await expect(finalizeAsset({ assetId: "asset-1", viewer })).rejects.toMatchObject({
      name: "AssetError",
      code: "MIME_MISMATCH",
    });
    expect(db.asset.update).not.toHaveBeenCalled();
  });

  it("rejects SVG bytes labeled image/jpeg with MIME_MISMATCH", async () => {
    db.asset.findUnique.mockResolvedValue(makeRow({ mimeType: "image/jpeg" }));
    headMock.mockResolvedValue({ contentLength: 1024, contentType: "image/jpeg" });
    prefixMock.mockResolvedValue(
      new Uint8Array([...'<svg xmlns="http://www.w3.org/2000/svg">'].map((c) => c.charCodeAt(0))),
    );

    await expect(finalizeAsset({ assetId: "asset-1", viewer })).rejects.toMatchObject({
      name: "AssetError",
      code: "MIME_MISMATCH",
    });
    expect(db.asset.update).not.toHaveBeenCalled();
  });

  it("persists the sniffed type when it differs non-dangerously (png declared, jpeg bytes)", async () => {
    db.asset.findUnique.mockResolvedValue(makeRow({ mimeType: "image/png" }));
    headMock.mockResolvedValue({ contentLength: 1024, contentType: "image/png" });
    prefixMock.mockResolvedValue(JPEG_MAGIC);
    db.asset.update.mockResolvedValue(makeRow({ mimeType: "image/jpeg", status: "READY" }));

    const meta = await finalizeAsset({ assetId: "asset-1", viewer });

    expect(meta.mimeType).toBe("image/jpeg");
    expect(db.asset.update).toHaveBeenCalledWith({
      where: { id: "asset-1" },
      data: { status: "READY", mimeType: "image/jpeg" },
      select: assetMetaSelect,
    });
  });

  it("keeps the declared type when the sniffer returns null (unknown format)", async () => {
    db.asset.findUnique.mockResolvedValue(makeRow({ mimeType: "text/plain" }));
    headMock.mockResolvedValue({ contentLength: 1024, contentType: "text/plain" });
    prefixMock.mockResolvedValue(new Uint8Array([..."just some text"].map((c) => c.charCodeAt(0))));
    db.asset.update.mockResolvedValue(makeRow({ mimeType: "text/plain", status: "READY" }));

    await finalizeAsset({ assetId: "asset-1", viewer });

    expect(db.asset.update).toHaveBeenCalledWith({
      where: { id: "asset-1" },
      data: { status: "READY" },
      select: assetMetaSelect,
    });
  });

  it("throws UPLOAD_MISSING when the prefix read finds no object", async () => {
    db.asset.findUnique.mockResolvedValue(makeRow());
    headMock.mockResolvedValue({ contentLength: 1024, contentType: "image/png" });
    prefixMock.mockResolvedValue(null);

    await expect(finalizeAsset({ assetId: "asset-1", viewer })).rejects.toMatchObject({
      name: "AssetError",
      code: "UPLOAD_MISSING",
    });
  });
});

describe("heartbeatAsset", () => {
  const viewer = { kind: "user" as const, userId: "user-1", role: "user" };

  it("binds the heartbeat to the exact PENDING storage key", async () => {
    db.asset.findUnique.mockResolvedValue({
      id: "asset-1",
      ownerId: "user-1",
      status: "PENDING",
      storageKey: "assets/original-upload",
    });
    db.asset.updateMany.mockResolvedValue({ count: 1 });

    await heartbeatAsset({ assetId: "asset-1", viewer });

    expect(db.asset.findUnique).toHaveBeenCalledWith({
      where: { id: "asset-1" },
      select: { id: true, ownerId: true, status: true, storageKey: true },
    });
    expect(db.asset.updateMany).toHaveBeenCalledWith({
      where: {
        id: "asset-1",
        status: "PENDING",
        storageKey: "assets/original-upload",
      },
      data: { uploadHeartbeatAt: expect.any(Date) },
    });
  });

  it("treats a concurrent READY transition as a benign lost CAS", async () => {
    db.asset.findUnique.mockResolvedValue({
      id: "asset-1",
      ownerId: "user-1",
      status: "PENDING",
      storageKey: "assets/original-upload",
    });
    db.asset.updateMany.mockResolvedValue({ count: 0 });

    await expect(heartbeatAsset({ assetId: "asset-1", viewer })).resolves.toBeUndefined();
    expect(db.asset.update).not.toHaveBeenCalled();
    expect(db.asset.updateMany).toHaveBeenCalledOnce();
  });

  it("does not write when the row was already READY", async () => {
    db.asset.findUnique.mockResolvedValue({
      id: "asset-1",
      ownerId: "user-1",
      status: "READY",
      storageKey: "assets/original-upload",
    });

    await heartbeatAsset({ assetId: "asset-1", viewer });

    expect(db.asset.updateMany).not.toHaveBeenCalled();
  });
});

describe("AssetError", () => {
  it("preserves the code field for HTTP mapping", () => {
    const err = new AssetError("UPLOAD_MISSING", "x");
    expect(err.code).toBe("UPLOAD_MISSING");
    expect(err.name).toBe("AssetError");
  });
});
