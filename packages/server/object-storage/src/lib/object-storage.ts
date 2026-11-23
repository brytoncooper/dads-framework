/**
 * Shared object-storage seam (put/get/delete/list/signed URL by object key).
 * `OBJECT_STORAGE_DRIVER` selects memory (tests/dev) or S3-compatible (MinIO, AWS, Spaces).
 */
export type StoredObject = {
  body: Uint8Array;
  contentType: string;
};

/** The uploader must send exactly these bytes: this content type, byte length and SHA-256. */
export type SignedUploadRequest = {
  readonly contentType: string;
  readonly byteSize: number;
  /** Lowercase hex SHA-256 of the exact bytes. */
  readonly sha256: string;
  readonly expiresInSeconds: number;
};

/** One PUT to `url`, sending every header in `headers` unchanged. */
export type SignedUpload = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
};

export abstract class ObjectStorage {
  abstract put(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
  abstract get(key: string): Promise<StoredObject | null>;
  /** Time-limited download URL — hand to clients instead of proxying bytes. */
  abstract getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
  /** Time-limited single PUT, so a client uploads bytes straight to storage. Storage refuses any other bytes. */
  abstract getSignedUpload(key: string, request: SignedUploadRequest): Promise<SignedUpload>;
  abstract delete(key: string): Promise<void>;
  /** Every object key that starts with the prefix, across all pages. */
  abstract list(prefix: string): Promise<string[]>;
}
