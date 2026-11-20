import { describe, expect, it } from "vitest";
import { InMemoryDirectTransferStorage } from "./in-memory-direct-transfer-storage.js";
import { MultipartImageUpload } from "./multipart-image-upload.js";

const at = new Date("2026-10-19T12:00:00Z");
const expiresAt = new Date("2026-10-19T12:15:00Z");

async function fixture() {
  const transfers = new InMemoryDirectTransferStorage();
  const transport = new MultipartImageUpload(transfers, transfers.objects);
  const receipt = await transport.start({
    key: "quarantine/avatar/user/id",
    contentType: "image/png",
    byteSize: 3,
    at,
    expiresAt,
  });
  const upload = {
    key: "quarantine/avatar/user/id",
    storageUploadId: receipt.storageUploadId,
  };
  transfers.receivePart(upload, 1, new Uint8Array([1, 2, 3]));
  return { transfers, transport, upload };
}

describe("MultipartImageUpload", () => {
  it("binds the image part URL to the declared byte count", async () => {
    const f = await fixture();
    expect(() =>
      f.transfers.receivePart(f.upload, 1, new Uint8Array(4)),
    ).toThrow();
    expect(() =>
      f.transfers.receivePart(f.upload, 1, new Uint8Array(2)),
    ).toThrow();
  });
  it("refuses extra parts before completing or reading an oversized object", async () => {
    const f = await fixture();
    f.transfers.receivePart(f.upload, 2, new Uint8Array([4]));
    expect(
      await f.transport.finish({
        ...f.upload,
        contentType: "image/png",
        maxBytes: 3,
        at,
      }),
    ).toBeNull();
    expect(f.transfers.isOpen(f.upload)).toBe(true);
    expect(await f.transfers.objects.get(f.upload.key)).toBeNull();
  });
  it("refuses expired quarantine receipts", async () => {
    const f = await fixture();
    expect(
      await f.transport.finish({
        ...f.upload,
        contentType: "image/png",
        maxBytes: 3,
        at: expiresAt,
      }),
    ).toBeNull();
  });
  it("refuses a declared content type that differs from the stored type", async () => {
    const f = await fixture();
    expect(
      await f.transport.finish({
        ...f.upload,
        contentType: "image/jpeg",
        maxBytes: 3,
        at,
      }),
    ).toBeNull();
  });
  it("returns exact bytes after size, metadata, expiry and type checks", async () => {
    const f = await fixture();
    expect(
      await f.transport.finish({
        ...f.upload,
        contentType: "image/png",
        maxBytes: 3,
        at,
      }),
    ).toEqual({ body: new Uint8Array([1, 2, 3]), contentType: "image/png" });
  });
  it("cleanup after processing preserves the outcome when storage deletion is unavailable", async () => {
    class UnavailableCleanup extends InMemoryDirectTransferStorage {
      override deleteObject(): Promise<void> {
        return Promise.reject(new Error("storage unavailable"));
      }
    }
    const transfers = new UnavailableCleanup();
    const transport = new MultipartImageUpload(transfers, transfers.objects);
    await expect(
      transport.discardAfterProcessing({
        key: "quarantine/image/own",
        storageUploadId: "own",
      }),
    ).resolves.toBeUndefined();
    await expect(
      transport.discard({
        key: "quarantine/image/own",
        storageUploadId: "own",
      }),
    ).rejects.toThrow("storage unavailable");
  });
});
