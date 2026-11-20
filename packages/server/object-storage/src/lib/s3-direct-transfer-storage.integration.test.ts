import { objectStorageConformance } from "../testing.js";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MultipartImageUpload } from "./multipart-image-upload.js";
import { S3DirectTransferStorage } from "./s3-direct-transfer-storage.js";
import { S3ObjectStorage } from "./s3-object-storage.js";

// MinIO stopped publishing anonymously pullable images (Docker Hub minio/minio
// 404s; quay.io/minio/minio answers 401 "unauthorized" to anonymous pulls, which
// is what failed the merge queue). Bitnami's frozen Docker Hub mirror still
// pulls anonymously, ships MinIO release 2025-07-23, and is pinned by tag and
// multi-arch index digest. Its entrypoint is a setup script, so the MinIO binary
// is started directly, serving the one directory the non-root user owns.
const MINIO_IMAGE =
  "docker.io/bitnamilegacy/minio:2025.7.23-debian-12-r5@sha256:6dabb4a2088c9a79908de3bc05f4586c23ad2182c8908e7e3acbf61c1467fb20";
const MINIO_BINARY = "/opt/bitnami/minio/bin/minio";
const MINIO_DATA_DIRECTORY = "/bitnami/minio/data";
const MINIO_API_PORT = 9000;
const BUCKET = "direct-transfer-test";
const CREDENTIALS = {
  accessKeyId: "minioadmin",
  secretAccessKey: "minioadmin",
};
const FIVE_MIB = 5 * 1024 * 1024;

describe("S3DirectTransferStorage against MinIO", () => {
  let container: StartedTestContainer | undefined;
  let storage: S3DirectTransferStorage;
  let objects: S3ObjectStorage;

  beforeAll(async () => {
    container = await new GenericContainer(MINIO_IMAGE)
      .withEntrypoint([MINIO_BINARY])
      .withCommand(["server", MINIO_DATA_DIRECTORY])
      .withEnvironment({
        MINIO_ROOT_USER: CREDENTIALS.accessKeyId,
        MINIO_ROOT_PASSWORD: CREDENTIALS.secretAccessKey,
      })
      .withExposedPorts(MINIO_API_PORT)
      .withWaitStrategy(
        Wait.forHttp("/minio/health/live", MINIO_API_PORT).forStatusCode(200),
      )
      .start();

    const endpoint = `http://${container.getHost()}:${container.getMappedPort(MINIO_API_PORT).toString()}`;
    const options = {
      endpoint,
      region: "us-east-1",
      bucket: BUCKET,
      credentials: CREDENTIALS,
      useBucketInPath: true,
    };
    const admin = new S3Client({
      endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: CREDENTIALS,
    });
    await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
    admin.destroy();
    storage = new S3DirectTransferStorage(options);
    objects = new S3ObjectStorage(options);
  });

  afterAll(async () => {
    await container?.stop();
  });

  it.each(objectStorageConformance)("$name", async ({ run }) => {
    await run(objects);
  });

  async function putPart(
    url: string,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<string> {
    const response = await fetch(url, { method: "PUT", body: bytes });
    expect(response.status).toBe(200);
    const etag = response.headers.get("etag");
    if (etag === null) throw new Error("MinIO returned no ETag for the part");
    return etag;
  }

  it("enforces the signed image byte count and verifies a browser-style single-part upload", async () => {
    const transport = new MultipartImageUpload(storage, objects);
    const at = new Date();
    const expiresAt = new Date(at.getTime() + 300000);
    const key = "quarantine/integration/image";
    const receipt = await transport.start({
      key,
      contentType: "image/png",
      byteSize: 3,
      at,
      expiresAt,
    });
    const refused = await fetch(receipt.uploadUrl, {
      method: "PUT",
      body: new Uint8Array(4),
    });
    expect(refused.status).toBe(403);
    await refused.arrayBuffer();
    await putPart(receipt.uploadUrl, new Uint8Array([1, 2, 3]));
    const upload = { key, storageUploadId: receipt.storageUploadId };
    expect(
      await transport.finish({
        ...upload,
        contentType: "image/png",
        maxBytes: 3,
        at,
      }),
    ).toEqual({ body: new Uint8Array([1, 2, 3]), contentType: "image/png" });
    await transport.discard(upload);
    expect(await storage.headObject(key)).toBeNull();
  });

  it("runs a multipart upload from start to download", async () => {
    const key = "maintenance/test/report.bin";
    const part1 = new Uint8Array(FIVE_MIB).fill(0x41);
    const part2 = new TextEncoder().encode("tail bytes");

    const upload = await storage.startMultipartUpload({
      key,
      contentType: "application/x-test",
      metadata: { owner: "integration" },
    });

    const url1 = await storage.presignUploadPart({
      ...upload,
      partNumber: 1,
      expiresInSeconds: 300,
    });
    const url2 = await storage.presignUploadPart({
      ...upload,
      partNumber: 2,
      expiresInSeconds: 300,
    });
    // Upload out of order: the listing must still come back sorted.
    const etag2 = await putPart(url2, part2);
    const etag1 = await putPart(url1, part1);

    const listed = await storage.listUploadedParts(upload);
    expect(listed).toEqual([
      { partNumber: 1, etag: etag1, byteSize: FIVE_MIB },
      { partNumber: 2, etag: etag2, byteSize: part2.byteLength },
    ]);

    await storage.completeMultipartUpload({
      ...upload,
      parts: [
        { partNumber: 1, etag: etag1 },
        { partNumber: 2, etag: etag2 },
      ],
    });
    expect(await storage.listUploadedParts(upload)).toBeNull();

    expect(await storage.headObject(key)).toEqual({
      byteSize: FIVE_MIB + part2.byteLength,
      contentType: "application/x-test",
      metadata: { owner: "integration" },
    });
    expect(await storage.readObjectPrefix(key, 16)).toEqual(
      new Uint8Array(16).fill(0x41),
    );

    const downloadUrl = await storage.presignAttachmentDownload({
      key,
      fileName: "report.bin",
      expiresInSeconds: 300,
    });
    const download = await fetch(downloadUrl);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toMatch(
      /^attachment; filename=/,
    );
    await download.arrayBuffer();

    await storage.deleteObject(key);
    expect(await storage.headObject(key)).toBeNull();
  });

  it("aborts an open upload idempotently", async () => {
    const upload = await storage.startMultipartUpload({
      key: "maintenance/test/abandoned.bin",
      contentType: "application/octet-stream",
      metadata: {},
    });

    await storage.abortMultipartUpload(upload);
    await storage.abortMultipartUpload(upload);

    expect(await storage.listUploadedParts(upload)).toBeNull();
  });

  it("reports a missing object as null", async () => {
    expect(await storage.headObject("maintenance/test/missing.bin")).toBeNull();
    expect(
      await storage.readObjectPrefix("maintenance/test/missing.bin", 16),
    ).toBeNull();
  });

  describe("write-once signed upload", () => {
    const body = new TextEncoder().encode("site-made file");
    const sha256 = createHash("sha256").update(body).digest("hex");

    async function putWithSignedHeaders(upload: {
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    }): Promise<Response> {
      // fetch sets Content-Length from the body; it matches the signed value.
      const headers = Object.entries(upload.headers).filter(
        ([name]) => name !== "content-length",
      );
      return fetch(upload.url, { method: "PUT", headers, body });
    }

    it("stores the object once and refuses a second write to the same key", async () => {
      const key = "maintenance/uploads/test/write-once.bin";
      const upload = await storage.presignWriteOnceUpload({
        key,
        contentType: "application/octet-stream",
        byteSize: body.byteLength,
        sha256,
        expiresInSeconds: 300,
      });
      expect(upload.headers["if-none-match"]).toBe("*");

      const first = await putWithSignedHeaders(upload);
      expect(first.status).toBe(200);
      await first.arrayBuffer();

      // A sequential second write meets the stored object and fails the
      // If-None-Match precondition: 412 exactly (409 is only for a race).
      // Were the header ignored this would be 200 and the object rewritten.
      const second = await putWithSignedHeaders(upload);
      expect(second.status).toBe(412);
      await second.arrayBuffer();

      expect(await storage.headObjectChecksum(key)).toEqual({
        byteSize: body.byteLength,
        sha256,
      });
    });

    it("reports a null SHA-256 for a multipart object", async () => {
      const key = "maintenance/uploads/test/multipart.bin";
      const part1 = new Uint8Array(FIVE_MIB).fill(0x42);
      const part2 = new TextEncoder().encode("tail");
      const upload = await storage.startMultipartUpload({
        key,
        contentType: "application/octet-stream",
        metadata: {},
      });
      const url1 = await storage.presignUploadPart({
        ...upload,
        partNumber: 1,
        expiresInSeconds: 300,
      });
      const url2 = await storage.presignUploadPart({
        ...upload,
        partNumber: 2,
        expiresInSeconds: 300,
      });
      const etag1 = await putPart(url1, part1);
      const etag2 = await putPart(url2, part2);
      await storage.completeMultipartUpload({
        ...upload,
        parts: [
          { partNumber: 1, etag: etag1 },
          { partNumber: 2, etag: etag2 },
        ],
      });

      expect(await storage.headObjectChecksum(key)).toEqual({
        byteSize: FIVE_MIB + part2.byteLength,
        sha256: null,
      });
    });

    it("reports a missing object as null", async () => {
      expect(
        await storage.headObjectChecksum("maintenance/uploads/test/missing"),
      ).toBeNull();
    });
  });
});
