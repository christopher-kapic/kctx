import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: class {
      send = mocks.send;
    },
  };
});

// storage.ts runs buildStorage() at module load, which reads @starter/env/shared
// and (if S3_BUCKET is set) constructs an S3Client. Mock the env so the import
// is side-effect-free. The client itself is mocked so request-option forwarding
// can be tested without network I/O.
vi.mock("@starter/env/shared", () => ({
  env: {
    S3_BUCKET: "test-bucket",
    S3_ACCESS_KEY_ID: "test-key",
    S3_SECRET_ACCESS_KEY: "test-secret",
    S3_REGION: "auto",
  },
  S3_FORCE_PATH_STYLE: false,
}));

const {
  parseBucketSpec,
  applyKeyPrefix,
  stripKeyPrefix,
  getStorageObject,
  getStorageObjectStream,
  getStorageObjectRange,
  putStorageObject,
} = await import("./storage");

describe("storage cancellation", () => {
  it("forwards the caller AbortSignal to every GET and PUT", async () => {
    const controller = new AbortController();
    mocks.send.mockResolvedValue({ Body: undefined });
    await getStorageObject("small", controller.signal);
    await getStorageObjectStream("stream", controller.signal);
    await getStorageObjectRange("range", "bytes=0-1", controller.signal);
    await putStorageObject("put", Buffer.from("x"), "text/plain", controller.signal);

    expect(mocks.send).toHaveBeenCalledTimes(4);
    for (const [, options] of mocks.send.mock.calls) {
      expect(options).toEqual({ abortSignal: controller.signal });
    }
  });
});

describe("parseBucketSpec", () => {
  it.each([
    ["my-bucket", "my-bucket", ""],
    ["shared-dev/app-a", "shared-dev", "app-a/"],
    ["shared/team/app-a", "shared", "team/app-a/"],
    ["shared//app-a//", "shared", "app-a/"],
    ["bucket/", "bucket", ""],
    ["bucket///", "bucket", ""],
  ])("%s -> bucket %s, prefix %s", (raw, bucket, keyPrefix) => {
    expect(parseBucketSpec(raw)).toEqual({ bucket, keyPrefix });
  });

  it("a plain bucket name yields an empty prefix (byte-identical to legacy)", () => {
    const { bucket, keyPrefix } = parseBucketSpec("legacy-bucket");
    expect(bucket).toBe("legacy-bucket");
    expect(keyPrefix).toBe("");
    // Empty prefix must be an exact identity on keys.
    expect(applyKeyPrefix(keyPrefix, "assets/abc")).toBe("assets/abc");
    expect(stripKeyPrefix(keyPrefix, "assets/abc")).toBe("assets/abc");
  });
});

describe("applyKeyPrefix / stripKeyPrefix round-trip", () => {
  // The cleanup sweep compares stripKeyPrefix(LIST key) against the logical
  // Asset.storageKey in the DB. If this round-trip is ever lossy, the sweep
  // sees every object as unreferenced and deletes the whole prefix.
  const specs = [
    "my-bucket",
    "shared-dev/app-a",
    "shared/team/app-a",
    "shared//app-a//",
    "bucket/",
  ];
  const logicalKeys = [
    "assets/3f1c-uuid",
    "videos/vid_1/playlist.m3u8",
    "videos/vid_1/v/720/seg_0001.ts",
    "rawVideos/vid_1/source.mp4",
  ];

  for (const spec of specs) {
    const { keyPrefix } = parseBucketSpec(spec);
    for (const logical of logicalKeys) {
      it(`${spec} :: ${logical} survives apply→strip`, () => {
        const physical = applyKeyPrefix(keyPrefix, logical);
        expect(physical.startsWith(keyPrefix)).toBe(true);
        expect(stripKeyPrefix(keyPrefix, physical)).toBe(logical);
      });
    }
  }

  it("prefixes the physical key exactly as expected (LIST scoping)", () => {
    const { keyPrefix } = parseBucketSpec("shared/app-a");
    // The cleanup sweep lists under applyKeyPrefix(prefix, "assets/") — assert
    // it cannot reach a sibling app's objects in the shared bucket.
    expect(applyKeyPrefix(keyPrefix, "assets/")).toBe("app-a/assets/");
    expect(applyKeyPrefix(keyPrefix, "videos/")).toBe("app-a/videos/");
  });
});

describe("stripKeyPrefix defensive guard", () => {
  it("passes through a key that does not start with the prefix", () => {
    // Should never happen under a configured prefix, but must not corrupt the
    // key (slicing a non-matching key would mangle it).
    expect(stripKeyPrefix("app-a/", "assets/orphan")).toBe("assets/orphan");
  });

  it("empty prefix is a strict identity in both directions", () => {
    expect(applyKeyPrefix("", "videos/x")).toBe("videos/x");
    expect(stripKeyPrefix("", "videos/x")).toBe("videos/x");
  });
});
