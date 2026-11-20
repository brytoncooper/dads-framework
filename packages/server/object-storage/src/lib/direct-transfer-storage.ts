/**
 * Storage for bytes that travel straight between a browser and the bucket and
 * never pass through the API: the multipart upload lifecycle, the reads that
 * verify a finished upload, and short-lived attachment download links.
 *
 * The server holds every decision. It picks the key, fixes the content type
 * and metadata when the upload opens, signs one part URL at a time, assembles
 * the parts the bucket reports (never a part list a browser sends), and reads
 * the finished object back before anything records it.
 *
 * `ObjectStorage` stays the seam for bytes the API itself holds.
 */

import type { SignedUpload } from "../core.js";

/** One open multipart upload: the server-chosen key and the bucket's upload id. */
export type MultipartUploadRef = {
  readonly key: string;
  readonly storageUploadId: string;
};

/** A part the bucket holds for an open upload. */
export type UploadedPart = {
  readonly partNumber: number;
  readonly etag: string;
  readonly byteSize: number;
};

/** What the bucket reports about a stored object. */
export type StoredObjectHead = {
  readonly byteSize: number;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
};

/** One write-once PUT: the exact bytes (by size and SHA-256) the object must hold. */
export type WriteOnceUploadRequest = {
  readonly key: string;
  readonly contentType: string;
  readonly byteSize: number;
  /** Lowercase hex SHA-256 of the exact bytes. */
  readonly sha256: string;
  readonly expiresInSeconds: number;
};

/** Size and full-object SHA-256 of a stored object; `sha256` is null when the object carries none. */
export type StoredObjectChecksum = {
  readonly byteSize: number;
  readonly sha256: string | null;
};

export abstract class DirectTransferStorage {
  /** Opens a multipart upload; the content type and metadata are fixed here, never by the browser. */
  abstract startMultipartUpload(input: {
    readonly key: string;
    readonly contentType: string;
    readonly metadata: Readonly<Record<string, string>>;
  }): Promise<MultipartUploadRef>;

  /** A PUT URL for exactly one part of one open upload. */
  abstract presignUploadPart(
    input: MultipartUploadRef & {
      readonly partNumber: number;
      /** When supplied, storage accepts exactly this many bytes for the part. */
      readonly byteSize?: number;
      readonly expiresInSeconds: number;
    },
  ): Promise<string>;

  /** The parts the bucket holds, in part order; null once the upload is completed, aborted or unknown. */
  abstract listUploadedParts(
    upload: MultipartUploadRef,
  ): Promise<readonly UploadedPart[] | null>;

  /** Assembles the given parts, in order, into the object at the upload's key. */
  abstract completeMultipartUpload(
    input: MultipartUploadRef & {
      readonly parts: readonly Pick<UploadedPart, "partNumber" | "etag">[];
    },
  ): Promise<void>;

  /** Discards an open upload's parts; succeeds when the upload is already gone. */
  abstract abortMultipartUpload(upload: MultipartUploadRef): Promise<void>;

  /** Size, type and metadata of a stored object; null when there is none. */
  abstract headObject(key: string): Promise<StoredObjectHead | null>;

  /** The first `byteCount` bytes of a stored object (all of it when shorter); null when there is none. */
  abstract readObjectPrefix(
    key: string,
    byteCount: number,
  ): Promise<Uint8Array | null>;

  /** A GET URL that downloads the object as an attachment under `fileName`. */
  abstract presignAttachmentDownload(input: {
    readonly key: string;
    readonly fileName: string;
    readonly expiresInSeconds: number;
  }): Promise<string>;

  /**
   * Removes a stored object; succeeds when it is already gone. On a versioned
   * bucket this adds a delete marker; a bucket lifecycle rule, not the caller,
   * frees the noncurrent bytes later.
   */
  abstract deleteObject(key: string): Promise<void>;

  /** One PUT of exactly these bytes, refused by storage if any object already exists at the key. */
  abstract presignWriteOnceUpload(
    input: WriteOnceUploadRequest,
  ): Promise<SignedUpload>;

  /**
   * Size and lowercase hex SHA-256 of a stored object; null when there is
   * none. `sha256` is null when the object has no full-object SHA-256, such as
   * a multipart upload.
   */
  abstract headObjectChecksum(
    key: string,
  ): Promise<StoredObjectChecksum | null>;
}
