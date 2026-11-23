// A signed upload sends exactly the signed headers to the storage URL, and a refusal is an error, not a silent success.
import { afterEach, describe, expect, it, vi } from "vitest";

import { putToSignedUrl, SignedUploadRefusedError } from "./signed-url-upload.js";

afterEach(() => vi.unstubAllGlobals());

describe("putToSignedUrl", () => {
  it("PUTs the body with only the signed headers", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push(init === undefined ? { url } : { url, init });
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    const body = new Uint8Array([1, 2, 3]).buffer;
    await putToSignedUrl({
      url: "https://storage.test/object",
      headers: { "content-type": "image/png" },
      body,
    });
    expect(calls).toEqual([
      {
        url: "https://storage.test/object",
        init: {
          method: "PUT",
          headers: { "content-type": "image/png" },
          body,
          signal: undefined,
        },
      },
    ]);
  });

  it("rejects when storage refuses the bytes", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(null, { status: 403 })));
    await expect(
      putToSignedUrl({
        url: "https://storage.test/object",
        headers: {},
        body: new ArrayBuffer(1),
      }),
    ).rejects.toBeInstanceOf(SignedUploadRefusedError);
  });
});
