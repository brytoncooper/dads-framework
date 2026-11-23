import type { S3Client } from "@aws-sdk/client-s3";
import { loadS3Sdk, loadS3Presigner } from "./load-s3-sdk.js";

import type { CloudFrontDownloadSigner } from "./cloudfront-download-signer.js";
import type { ObjectStorage, SignedUpload, SignedUploadRequest, StoredObject } from "../core.js";

/** A fixed access key pair, e.g. MinIO's root user in development. */
export type S3StaticCredentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
};

export type S3ObjectStorageOptions = {
  /** MinIO: http://localhost:9000 · AWS: https://s3.<region>.amazonaws.com or unset · Spaces: https://<region>.digitaloceanspaces.com */
  endpoint?: string;
  readonly downloadSigner?: CloudFrontDownloadSigner;
  region: string;
  bucket: string;
  /**
   * A fixed key pair (MinIO, Spaces). Leave it unset on AWS: the SDK's
   * default credential chain then supplies short-lived credentials — the ECS
   * task role in production, the signed-in AWS profile on a laptop — so no
   * long-lived key is ever configured.
   */
  credentials?: S3StaticCredentials;
  /** MinIO needs the bucket in the path; AWS and Spaces put it in the host. */
  useBucketInPath: boolean;
};

/**
 * The S3 client settings for {@link S3ObjectStorageOptions}. Credentials are
 * passed only when a static pair is configured; otherwise the key is absent
 * so the SDK resolves its default credential chain.
 */
export function s3ClientConfig(options: S3ObjectStorageOptions) {
  return {
    region: options.region,
    forcePathStyle: options.useBucketInPath,
    // A checksum computed by default would cover a signed upload URL's empty
    // body, so storage would refuse the real bytes sent to that URL.
    requestChecksumCalculation: "WHEN_REQUIRED" as const,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.credentials
      ? {
          credentials: {
            accessKeyId: options.credentials.accessKeyId,
            secretAccessKey: options.credentials.secretAccessKey,
          },
        }
      : {}),
  };
}

/** S3 API driver — same client for MinIO, AWS S3, and DigitalOcean Spaces. */
export class S3ObjectStorage implements ObjectStorage {
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

  async put(key: string, body: Uint8Array | string, contentType: string): Promise<void> {
    const { sdk, client } = await this.loadClient();
    await client.send(
      new sdk.PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const { sdk, client } = await this.loadClient();
      const response = await client.send(new sdk.GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
      const body = await response.Body?.transformToByteArray();
      if (!body) return null;
      return {
        body,
        contentType: response.ContentType ?? "application/octet-stream",
      };
    } catch (error: unknown) {
      if (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound")) {
        return null;
      }
      throw error;
    }
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    if (this.options.downloadSigner) return Promise.resolve(this.options.downloadSigner.sign(key, expiresInSeconds));
    const { sdk, client } = await this.loadClient();
    const { getSignedUrl } = await loadS3Presigner();
    return getSignedUrl(client, new sdk.GetObjectCommand({ Bucket: this.options.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async getSignedUpload(key: string, request: SignedUploadRequest): Promise<SignedUpload> {
    const checksum = Buffer.from(request.sha256, "hex").toString("base64");
    const { sdk, client } = await this.loadClient();
    const { getSignedUrl } = await loadS3Presigner();
    const url = await getSignedUrl(
      client,
      new sdk.PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        ContentType: request.contentType,
        ContentLength: request.byteSize,
        ChecksumSHA256: checksum,
      }),
      {
        expiresIn: request.expiresInSeconds,
        // The presigner leaves these unsigned by default. Signing them makes
        // storage refuse other bytes, so a PUT after finalize can only write
        // the bytes already verified.
        signableHeaders: new Set(["content-type", "content-length", "x-amz-checksum-sha256"]),
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      },
    );
    return {
      url,
      headers: {
        "content-type": request.contentType,
        "content-length": String(request.byteSize),
        "x-amz-checksum-sha256": checksum,
      },
    };
  }

  async delete(key: string): Promise<void> {
    const { sdk, client } = await this.loadClient();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    const { sdk, client } = await this.loadClient();
    do {
      const response = await client.send(
        new sdk.ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key !== undefined) keys.push(object.Key);
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    return keys;
  }
}
