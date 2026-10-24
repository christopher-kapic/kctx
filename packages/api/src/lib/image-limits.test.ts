import { serverVars } from "@starter/env/vars/server";
import { describe, expect, it } from "vitest";

import { ASSET_UPLOAD_MAX_BYTES_DEFAULT, IMAGE_MAX_DIMENSION } from "./image-limits";

describe("image-limits", () => {
  it("keeps ASSET_UPLOAD_MAX_BYTES_DEFAULT in lockstep with the env schema default", () => {
    // The client constant and the server env default are deliberately
    // decoupled at runtime (no VITE_ mirror — see image-limits.ts). This test
    // is the drift alarm: importing the side-effect-free declaration object
    // (packages/env/src/vars/server.ts — no dotenv, no validation run) and
    // reading the Zod default turns a silent divergence into a red test.
    expect(serverVars.ASSET_UPLOAD_MAX_BYTES.parse(undefined)).toBe(ASSET_UPLOAD_MAX_BYTES_DEFAULT);
  });

  it("matches the server transform cap (4096)", () => {
    // images.ts aliases this constant as TRANSFORM_MAX_DIMENSION; images.test.ts
    // pins the 4096 behavior through normalizeTransformParams.
    expect(IMAGE_MAX_DIMENSION).toBe(4096);
  });
});
