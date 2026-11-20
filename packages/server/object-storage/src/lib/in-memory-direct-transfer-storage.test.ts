/**
 * What: the in-memory direct-transfer driver behaves like the bucket for the
 * parts of the lifecycle the API depends on — parts listed in order, an
 * assembled object readable by size, type, metadata and prefix, and abort and
 * completion closing the upload.
 * Why: every upload mutation's unit tests run on this fake; if it drifted from
 * S3's semantics (closed uploads listing parts, a mismatched ETag completing)
 * those tests would prove a lifecycle the real bucket refuses.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { InMemoryDirectTransferStorage } from "./in-memory-direct-transfer-storage.js";
import { InMemoryObjectStorage } from "../core.js";

const bytes = (...values: number[]) => Uint8Array.from(values);

describe("InMemoryDirectTransferStorage", () => {
  it("assembles listed parts in order and exposes the object to ObjectStorage readers", async () => {
    const objects = new InMemoryObjectStorage();
    const storage = new InMemoryDirectTransferStorage(objects);
    const upload = await storage.startMultipartUpload({
      key: "maintenance/org/facility/asset-file/asset/upload",
      contentType: "application/pdf",
      metadata: { "upload-id": "upload" },
    });
    const second = storage.receivePart(upload, 2, bytes(3, 4));
    const first = storage.receivePart(upload, 1, bytes(1, 2));

    expect(await storage.listUploadedParts(upload)).toEqual([
      { partNumber: 1, etag: first, byteSize: 2 },
      { partNumber: 2, etag: second, byteSize: 2 },
    ]);

    await storage.completeMultipartUpload({
      ...upload,
      parts: [
        { partNumber: 1, etag: first },
        { partNumber: 2, etag: second },
      ],
    });

    expect(storage.isOpen(upload)).toBe(false);
    expect(await storage.listUploadedParts(upload)).toBeNull();
    expect(await storage.headObject(upload.key)).toEqual({
      byteSize: 4,
      contentType: "application/pdf",
      metadata: { "upload-id": "upload" },
    });
    expect(await storage.readObjectPrefix(upload.key, 3)).toEqual(
      bytes(1, 2, 3),
    );
    expect((await objects.get(upload.key))?.body).toEqual(bytes(1, 2, 3, 4));
  });

  it("refuses to complete with an ETag the bucket did not issue", async () => {
    const storage = new InMemoryDirectTransferStorage();
    const upload = await storage.startMultipartUpload({
      key: "key",
      contentType: "text/plain",
      metadata: {},
    });
    storage.receivePart(upload, 1, bytes(1));

    await expect(
      storage.completeMultipartUpload({
        ...upload,
        parts: [{ partNumber: 1, etag: '"forged"' }],
      }),
    ).rejects.toThrow("InvalidPart");
    expect(storage.isOpen(upload)).toBe(true);
  });

  it("aborts idempotently and forgets the parts", async () => {
    const storage = new InMemoryDirectTransferStorage();
    const upload = await storage.startMultipartUpload({
      key: "key",
      contentType: "text/plain",
      metadata: {},
    });
    storage.receivePart(upload, 1, bytes(1));

    await storage.abortMultipartUpload(upload);
    await storage.abortMultipartUpload(upload);

    expect(await storage.listUploadedParts(upload)).toBeNull();
    expect(await storage.headObject("key")).toBeNull();
  });

  it("does not answer for an upload id under a different key", async () => {
    const storage = new InMemoryDirectTransferStorage();
    const upload = await storage.startMultipartUpload({
      key: "issued",
      contentType: "text/plain",
      metadata: {},
    });

    expect(
      await storage.listUploadedParts({ ...upload, key: "other" }),
    ).toBeNull();
  });

  it("deletes an object, and deleting it again succeeds", async () => {
    const storage = new InMemoryDirectTransferStorage();
    const upload = await storage.startMultipartUpload({
      key: "removed",
      contentType: "text/plain",
      metadata: {},
    });
    const etag = storage.receivePart(upload, 1, bytes(1));
    await storage.completeMultipartUpload({
      ...upload,
      parts: [{ partNumber: 1, etag }],
    });

    await storage.deleteObject("removed");
    await storage.deleteObject("removed");
    expect(await storage.headObject("removed")).toBeNull();
  });

  it("signs literal part and download URLs", async () => {
    const storage = new InMemoryDirectTransferStorage();
    const upload = await storage.startMultipartUpload({
      key: "key",
      contentType: "text/plain",
      metadata: {},
    });

    expect(
      await storage.presignUploadPart({
        ...upload,
        partNumber: 1,
        expiresInSeconds: 900,
      }),
    ).toBe(
      `memory://upload/key?uploadId=${upload.storageUploadId}&partNumber=1&expires=900`,
    );
    expect(
      await storage.presignAttachmentDownload({
        key: "key",
        fileName: "a b.pdf",
        expiresInSeconds: 300,
      }),
    ).toBe("memory://download/key?filename=a%20b.pdf&expires=300");
  });

  it("signs a write-once upload as an inspectable URL and writes nothing", async () => {
    const storage = new InMemoryDirectTransferStorage();
    const sha256 = createHash("sha256")
      .update(bytes(1, 2, 3))
      .digest("hex");

    const upload = await storage.presignWriteOnceUpload({
      key: "key",
      contentType: "image/png",
      byteSize: 3,
      sha256,
      expiresInSeconds: 3600,
    });

    expect(upload.url).toBe(
      `memory://write-once/key?bytes=3&sha256=${sha256}&if-none-match=*&expires=3600`,
    );
    expect(upload.headers).toEqual({
      "content-type": "image/png",
      "content-length": "3",
      "x-amz-checksum-sha256": Buffer.from(sha256, "hex").toString("base64"),
      "if-none-match": "*",
    });
    expect(await storage.headObjectChecksum("key")).toBeNull();
  });

  it("reports the size and SHA-256 of a stored object, and null for a missing key", async () => {
    const objects = new InMemoryObjectStorage();
    const storage = new InMemoryDirectTransferStorage(objects);
    await objects.put("stored", bytes(1, 2, 3), "application/octet-stream");

    expect(await storage.headObjectChecksum("stored")).toEqual({
      byteSize: 3,
      sha256: createHash("sha256")
        .update(bytes(1, 2, 3))
        .digest("hex"),
    });
    expect(await storage.headObjectChecksum("missing")).toBeNull();
  });
});
