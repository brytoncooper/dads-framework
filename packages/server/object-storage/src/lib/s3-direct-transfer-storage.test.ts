import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { S3DirectTransferStorage } from "./s3-direct-transfer-storage.js";

describe("S3DirectTransferStorage part URL", () => {
  it("signs Content-Length for a bounded image part", async () => {
    const storage = new S3DirectTransferStorage({
      region: "us-west-1",
      bucket: "private-test",
      useBucketInPath: false,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    const url = new URL(
      await storage.presignUploadPart({
        key: "quarantine/image",
        storageUploadId: "upload",
        partNumber: 1,
        byteSize: 123,
        expiresInSeconds: 900,
      }),
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toContain(
      "content-length",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
  });
});

describe("S3DirectTransferStorage write-once upload", () => {
  const bytes = new TextEncoder().encode("site photo");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const checksum = Buffer.from(sha256, "hex").toString("base64");

  async function presign() {
    const storage = new S3DirectTransferStorage({
      region: "us-west-1",
      bucket: "private-test",
      useBucketInPath: false,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    return storage.presignWriteOnceUpload({
      key: "maintenance/uploads/org/facility/service-photo/record/id",
      contentType: "image/jpeg",
      byteSize: bytes.byteLength,
      sha256,
      expiresInSeconds: 3600,
    });
  }

  it("signs If-None-Match, the checksum, the content type and the length", async () => {
    const url = new URL((await presign()).url);
    const signedHeaders =
      url.searchParams.get("X-Amz-SignedHeaders")?.split(";") ?? [];
    expect(signedHeaders).toEqual(
      expect.arrayContaining([
        "content-type",
        "content-length",
        "x-amz-checksum-sha256",
        "if-none-match",
      ]),
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
  });

  it("returns the headers the uploader must send, including if-none-match:*", async () => {
    expect((await presign()).headers).toEqual({
      "content-type": "image/jpeg",
      "content-length": String(bytes.byteLength),
      "x-amz-checksum-sha256": checksum,
      "if-none-match": "*",
    });
  });
});
