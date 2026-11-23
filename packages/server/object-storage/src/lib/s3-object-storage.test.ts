/**
 * What: the S3 driver passes a static key pair only when one is configured.
 * Why: on AWS the API must use its ECS task role (and the publisher the
 * signed-in profile) through the SDK's default credential chain — a
 * hard-coded fallback key would silently shadow the role and fail, or worse,
 * tempt someone to paste a long-lived key into production.
 */
import { describe, expect, it } from "vitest";

import { S3ObjectStorage, s3ClientConfig } from "./s3-object-storage.js";

describe("s3ClientConfig", () => {
  it("leaves credentials unset so AWS uses the default credential chain", () => {
    const config = s3ClientConfig({
      endpoint: "https://s3.us-west-1.amazonaws.com",
      region: "us-west-1",
      bucket: "example-application-objects",
      useBucketInPath: false,
    });

    expect(config).not.toHaveProperty("credentials");
    expect(config).toMatchObject({
      region: "us-west-1",
      endpoint: "https://s3.us-west-1.amazonaws.com",
      forcePathStyle: false,
    });
  });

  it("passes a static key pair when one is configured (MinIO)", () => {
    const config = s3ClientConfig({
      endpoint: "http://localhost:9000",
      region: "us-east-1",
      bucket: "example-application-objects",
      credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
      useBucketInPath: true,
    });

    expect(config.credentials).toEqual({
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
    });
    expect(config.forcePathStyle).toBe(true);
  });

  it("omits the endpoint when none is configured", () => {
    const config = s3ClientConfig({
      region: "us-west-1",
      bucket: "example-application-objects",
      useBucketInPath: false,
    });

    expect(config).not.toHaveProperty("endpoint");
  });

  it("adds no default checksum, which would not match bytes sent to a signed upload URL", () => {
    const config = s3ClientConfig({
      region: "us-west-1",
      bucket: "example-application-objects",
      useBucketInPath: false,
    });

    expect(config.requestChecksumCalculation).toBe("WHEN_REQUIRED");
  });
});

describe("S3ObjectStorage.getSignedUpload", () => {
  it("signs the content type, exact length and SHA-256 into a single PUT", async () => {
    const storage = new S3ObjectStorage({
      endpoint: "http://localhost:9000",
      region: "us-east-1",
      bucket: "example-application-objects",
      credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
      useBucketInPath: true,
    });
    const sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    const upload = await storage.getSignedUpload("photos/one", {
      contentType: "image/png",
      byteSize: 1024,
      sha256,
      expiresInSeconds: 600,
    });
    const url = new URL(upload.url);

    expect(url.pathname).toBe("/example-application-objects/photos/one");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host;x-amz-checksum-sha256");
    expect(url.searchParams.has("x-amz-checksum-sha256")).toBe(false);
    expect(url.searchParams.has("x-amz-checksum-crc32")).toBe(false);
    expect(upload.headers).toEqual({
      "content-type": "image/png",
      "content-length": "1024",
      "x-amz-checksum-sha256": "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    });
  });
});
