import { afterEach, describe, expect, it, vi } from "vitest";

import { createRequestId, uuidV4FromRandomBytes } from "./create-request-id.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("createRequestId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a v4 UUID when crypto.randomUUID exists", () => {
    expect(createRequestId()).toMatch(UUID_V4);
  });

  it("still returns a v4 UUID on an insecure page, where crypto.randomUUID is missing", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(0xff),
    });

    expect(createRequestId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });
});

describe("uuidV4FromRandomBytes", () => {
  it("stamps the version and variant bits", () => {
    expect(uuidV4FromRandomBytes(new Uint8Array(16))).toBe(
      "00000000-0000-4000-8000-000000000000",
    );
  });
});
