import type { Part, S3Client } from "@aws-sdk/client-s3";
import { loadS3Sdk, loadS3Presigner } from "./load-s3-sdk.js";

import type { DirectTransferStorage } from "./direct-transfer-storage.js";
import {
  type MultipartUploadRef,
  type StoredObjectChecksum,
  type StoredObjectHead,
  type UploadedPart,
  type WriteOnceUploadRequest,
} from "./direct-transfer-storage.js";
import { attachmentDisposition } from "./logic/attachment-disposition.js";
import type { SignedUpload } from "../core.js";
import {
  s3ClientConfig,
  type S3ObjectStorageOptions,
} from "./s3-object-storage.js";

/**
 * S3 API driver for browser-direct transfers — the same client settings as
 * `S3ObjectStorage`, so MinIO (path-style, static key), AWS (task role)
 * and Spaces all work from the existing `OBJECT_STORAGE_*` configuration.
 *
 * Presigned URLs are signed for the configured endpoint, which the browser
 * must be able to reach: `http://localhost:<slot port>` for a dev slot's
 * MinIO, the regional S3 host in production.
 */
export class S3DirectTransferStorage implements DirectTransferStorage {
  private readonly config: ReturnType<typeof s3ClientConfig>;
  private client?: S3Client;

  constructor(private readonly options: S3ObjectStorageOptions) {
    this.config = s3ClientConfig(options);
  }

  private async loadClient() {
    const sdk = await loadS3Sdk();
    const client = (this.client ??= new sdk.S3Client(this.config));
    return { sdk, client };
  }

  async startMultipartUpload(input: {
    readonly key: string;
    readonly contentType: string;
    readonly metadata: Readonly<Record<string, string>>;
  }): Promise<MultipartUploadRef> {
    const { sdk, client } = await this.loadClient();
    const response = await client.send(
      new sdk.CreateMultipartUploadCommand({
        Bucket: this.options.bucket,
        Key: input.key,
        ContentType: input.contentType,
        Metadata: { ...input.metadata },
      }),
    );
    if (!response.UploadId)
      throw new Error("The bucket opened a multipart upload without an id");
    return { key: input.key, storageUploadId: response.UploadId };
  }

  async presignUploadPart(
    input: MultipartUploadRef & {
      readonly partNumber: number;
      readonly byteSize?: number;
      readonly expiresInSeconds: number;
    },
  ): Promise<string> {
    const { sdk, client } = await this.loadClient();
    const { getSignedUrl } = await loadS3Presigner();
    return getSignedUrl(
      client,
      new sdk.UploadPartCommand({
        Bucket: this.options.bucket,
        Key: input.key,
        UploadId: input.storageUploadId,
        PartNumber: input.partNumber,
        ContentLength: input.byteSize,
      }),
      {
        expiresIn: input.expiresInSeconds,
        ...(input.byteSize === undefined
          ? {}
          : { signableHeaders: new Set(["content-length"]) }),
      },
    );
  }

  async listUploadedParts(
    upload: MultipartUploadRef,
  ): Promise<readonly UploadedPart[] | null> {
    try {
      return await this.listEveryUploadedPart(upload);
    } catch (error: unknown) {
      if (isNamed(error, "NoSuchUpload")) return null;
      throw error;
    }
  }

  private async listEveryUploadedPart(
    upload: MultipartUploadRef,
  ): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    const { sdk, client } = await this.loadClient();
    do {
      const page = await client.send(
        new sdk.ListPartsCommand({
          Bucket: this.options.bucket,
          Key: upload.key,
          UploadId: upload.storageUploadId,
          ...(marker === undefined ? {} : { PartNumberMarker: marker }),
        }),
      );
      parts.push(...toUploadedParts(page.Parts ?? []));
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker !== undefined);
    return parts.sort((left, right) => left.partNumber - right.partNumber);
  }

  async completeMultipartUpload(
    input: MultipartUploadRef & {
      readonly parts: readonly Pick<UploadedPart, "partNumber" | "etag">[];
    },
  ): Promise<void> {
    const { sdk, client } = await this.loadClient();
    await client.send(
      new sdk.CompleteMultipartUploadCommand({
        Bucket: this.options.bucket,
        Key: input.key,
        UploadId: input.storageUploadId,
        MultipartUpload: {
          Parts: input.parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(upload: MultipartUploadRef): Promise<void> {
    try {
      const { sdk, client } = await this.loadClient();
      await client.send(
        new sdk.AbortMultipartUploadCommand({
          Bucket: this.options.bucket,
          Key: upload.key,
          UploadId: upload.storageUploadId,
        }),
      );
    } catch (error: unknown) {
      if (isNamed(error, "NoSuchUpload")) return;
      throw error;
    }
  }

  async headObject(key: string): Promise<StoredObjectHead | null> {
    try {
      const { sdk, client } = await this.loadClient();
      const response = await client.send(
        new sdk.HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      return {
        byteSize: response.ContentLength ?? 0,
        contentType: response.ContentType ?? "application/octet-stream",
        metadata: { ...response.Metadata },
      };
    } catch (error: unknown) {
      if (isNamed(error, "NotFound") || isNamed(error, "NoSuchKey"))
        return null;
      throw error;
    }
  }

  async readObjectPrefix(
    key: string,
    byteCount: number,
  ): Promise<Uint8Array | null> {
    try {
      const { sdk, client } = await this.loadClient();
      const response = await client.send(
        new sdk.GetObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          Range: `bytes=0-${Math.max(0, byteCount - 1).toString()}`,
        }),
      );
      return (await response.Body?.transformToByteArray()) ?? new Uint8Array();
    } catch (error: unknown) {
      if (isNamed(error, "NoSuchKey") || isNamed(error, "NotFound"))
        return null;
      if (isNamed(error, "InvalidRange")) return new Uint8Array();
      throw error;
    }
  }

  async presignAttachmentDownload(input: {
    readonly key: string;
    readonly fileName: string;
    readonly expiresInSeconds: number;
  }): Promise<string> {
    if (this.options.downloadSigner)
      return Promise.resolve(
        this.options.downloadSigner.sign(
          input.key,
          input.expiresInSeconds,
          input.fileName,
        ),
      );
    const { sdk, client } = await this.loadClient();
    const { getSignedUrl } = await loadS3Presigner();
    return getSignedUrl(
      client,
      new sdk.GetObjectCommand({
        Bucket: this.options.bucket,
        Key: input.key,
        ResponseContentDisposition: attachmentDisposition(input.fileName),
      }),
      { expiresIn: input.expiresInSeconds },
    );
  }

  async deleteObject(key: string): Promise<void> {
    const { sdk, client } = await this.loadClient();
    await client.send(
      new sdk.DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }),
    );
  }

  async presignWriteOnceUpload(
    input: WriteOnceUploadRequest,
  ): Promise<SignedUpload> {
    const checksum = Buffer.from(input.sha256, "hex").toString("base64");
    const { sdk, client } = await this.loadClient();
    const { getSignedUrl } = await loadS3Presigner();
    const url = await getSignedUrl(
      client,
      new sdk.PutObjectCommand({
        Bucket: this.options.bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.byteSize,
        ChecksumSHA256: checksum,
        IfNoneMatch: "*",
      }),
      {
        expiresIn: input.expiresInSeconds,
        // The presigner leaves these unsigned by default. Signing them makes
        // storage refuse other bytes and refuse any write over an existing
        // object, so the URL can only create this exact object once.
        signableHeaders: new Set([
          "content-type",
          "content-length",
          "x-amz-checksum-sha256",
          "if-none-match",
        ]),
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      },
    );
    return {
      url,
      headers: {
        "content-type": input.contentType,
        "content-length": String(input.byteSize),
        "x-amz-checksum-sha256": checksum,
        "if-none-match": "*",
      },
    };
  }

  async headObjectChecksum(key: string): Promise<StoredObjectChecksum | null> {
    try {
      const { sdk, client } = await this.loadClient();
      const response = await client.send(
        new sdk.HeadObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          ChecksumMode: "ENABLED",
        }),
      );
      return {
        byteSize: response.ContentLength ?? 0,
        sha256: fullObjectSha256Hex(
          response.ChecksumSHA256,
          response.ChecksumType,
        ),
      };
    } catch (error: unknown) {
      if (isNamed(error, "NotFound") || isNamed(error, "NoSuchKey"))
        return null;
      throw error;
    }
  }
}

/**
 * Hex of the object's full-object SHA-256, or null when the bucket reports
 * none. A multipart upload carries a composite checksum (a hash of part
 * hashes, marked `COMPOSITE` or written `<hash>-<parts>`), which is not the
 * SHA-256 of the bytes.
 */
function fullObjectSha256Hex(
  checksumBase64: string | undefined,
  checksumType: string | undefined,
): string | null {
  if (checksumBase64 === undefined || checksumBase64 === "") return null;
  if (checksumType === "COMPOSITE" || checksumBase64.includes("-")) return null;
  return Buffer.from(checksumBase64, "base64").toString("hex");
}

/** Drops parts the bucket listed without a number or ETag. */
function toUploadedParts(parts: readonly Part[]): UploadedPart[] {
  return parts.flatMap((part) =>
    part.PartNumber === undefined || part.ETag === undefined
      ? []
      : [
          {
            partNumber: part.PartNumber,
            etag: part.ETag,
            byteSize: part.Size ?? 0,
          },
        ],
  );
}

function isNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}
