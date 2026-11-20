import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskObjectStorage } from "./disk-object-storage.js";
import {
  advanceClock,
  now,
  PLENTY,
  PREFIX,
  recordingLog,
  root,
  storage,
  prepareDiskObjectStorageFixture,
  removeDiskObjectStorageFixture,
} from "./disk-object-storage.test-support.js";

beforeEach(prepareDiskObjectStorageFixture);
afterEach(removeDiskObjectStorageFixture);

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function linkParts(url: string): { key: string; expires: string; sig: string } {
  const parsed = new URL(url, "http://site.invalid");
  return {
    key: parsed.searchParams.get("key") ?? "",
    expires: parsed.searchParams.get("expires") ?? "",
    sig: parsed.searchParams.get("sig") ?? "",
  };
}

describe("signed download links", () => {
  it("answers a path-only link that opens the file before it expires", async () => {
    const files = storage();
    await files.put("a/b.png", "bytes", "image/png");

    const url = await files.getSignedUrl("a/b.png", 300);
    expect(url.startsWith(`${PREFIX}?`)).toBe(true);

    advanceClock(100_000);
    const opened = await files.readSignedDownload(linkParts(url));
    expect(opened?.object.contentType).toBe("image/png");
    expect(new TextDecoder().decode(opened?.object.body)).toBe("bytes");
    expect(opened?.remainingSeconds).toBe(200);
  });

  it("answers null once the link has expired", async () => {
    const files = storage();
    await files.put("a/b.png", "bytes", "image/png");
    const url = await files.getSignedUrl("a/b.png", 300);

    advanceClock(300_000);
    await expect(files.readSignedDownload(linkParts(url))).resolves.toBeNull();
  });

  it.each([
    ["key", { key: "a/c.png" }],
    ["expiry", { expires: "9999999999" }],
    ["signature", { sig: "0".repeat(64) }],
    ["signature's form", { sig: "not-hex" }],
  ])("answers null for a changed %s", async (_label, change) => {
    const files = storage();
    await files.put("a/b.png", "bytes", "image/png");
    await files.put("a/c.png", "other", "image/png");
    const url = await files.getSignedUrl("a/b.png", 300);

    await expect(
      files.readSignedDownload({ ...linkParts(url), ...change }),
    ).resolves.toBeNull();
  });

  it("answers null for an upload link used to download (another method)", async () => {
    const files = storage();
    await files.put("a/b.png", "bytes", "image/png");
    const upload = await files.getSignedUpload("a/b.png", {
      contentType: "image/png",
      byteSize: 5,
      sha256: sha256Hex("bytes"),
      expiresInSeconds: 300,
    });

    await expect(
      files.readSignedDownload(linkParts(upload.url)),
    ).resolves.toBeNull();
  });

  it("answers null for a link from another box's key", async () => {
    const files = storage();
    await files.put("a/b.png", "bytes", "image/png");
    const otherBox = new DiskObjectStorage({
      rootDirectory: root,
      signingKey: () => Promise.resolve(new Uint8Array(32).fill(9)),
      publicPathPrefix: PREFIX,
      clock: () => now,
      freeSpace: PLENTY,
      log: recordingLog(),
    });
    const url = await otherBox.getSignedUrl("a/b.png", 300);

    await expect(files.readSignedDownload(linkParts(url))).resolves.toBeNull();
  });

  it("answers null, not an error, for a link naming a key outside the root", async () => {
    await expect(
      storage().readSignedDownload({
        key: "../signing-key",
        expires: "9999999999",
        sig: "0".repeat(64),
      }),
    ).resolves.toBeNull();
  });
});

describe("signed uploads", () => {
  const BODY = new TextEncoder().encode("picture");

  async function signedUpload(files: DiskObjectStorage) {
    const upload = await files.getSignedUpload("a/up.png", {
      contentType: "image/png",
      byteSize: BODY.byteLength,
      sha256: sha256Hex(BODY),
      expiresInSeconds: 300,
    });
    const parsed = new URL(upload.url, "http://site.invalid");
    return {
      upload,
      received: {
        key: parsed.searchParams.get("key") ?? "",
        expires: parsed.searchParams.get("expires") ?? "",
        sig: parsed.searchParams.get("sig") ?? "",
        sha256: parsed.searchParams.get("sha256") ?? "",
        contentType: "image/png",
        byteSize: BODY.byteLength,
        body: BODY,
      },
    };
  }

  it("answers the headers the other drivers return", async () => {
    const { upload } = await signedUpload(storage());

    expect(upload.url.startsWith(`${PREFIX}?`)).toBe(true);
    expect(upload.headers).toEqual({
      "content-type": "image/png",
      "content-length": String(BODY.byteLength),
    });
  });

  it("stores exactly the signed bytes", async () => {
    const files = storage();
    const { received } = await signedUpload(files);

    await expect(files.receiveSignedUpload(received)).resolves.toBe("stored");
    const stored = await files.get("a/up.png");
    expect(stored?.contentType).toBe("image/png");
    expect(new TextDecoder().decode(stored?.body)).toBe("picture");
  });

  it.each([
    ["another content type", { contentType: "image/jpeg" }],
    ["another byte size", { byteSize: 3 }],
    ["another body", { body: new TextEncoder().encode("pictura") }],
    ["a body of another length", { body: new TextEncoder().encode("pic") }],
    ["another SHA-256", { sha256: sha256Hex("other") }],
    ["another key", { key: "a/other.png" }],
  ])("refuses %s and stores nothing", async (_label, change) => {
    const files = storage();
    const { received } = await signedUpload(files);

    await expect(
      files.receiveSignedUpload({ ...received, ...change }),
    ).resolves.toBe("refused");
    await expect(files.list("a/")).resolves.toEqual([]);
  });

  it("refuses an expired upload and stores nothing", async () => {
    const files = storage();
    const { received } = await signedUpload(files);
    advanceClock(301_000);

    await expect(files.receiveSignedUpload(received)).resolves.toBe("refused");
    await expect(files.list("a/")).resolves.toEqual([]);
  });

  it("refuses a download link used to upload (another method)", async () => {
    const files = storage();
    const { received } = await signedUpload(files);
    const download = linkParts(await files.getSignedUrl("a/up.png", 300));

    await expect(
      files.receiveSignedUpload({ ...received, ...download }),
    ).resolves.toBe("refused");
  });
});
