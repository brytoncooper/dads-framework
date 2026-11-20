import { concatenate, multipartError } from "./multipart-assembly.js";
import { createHash } from "node:crypto";

import type { DirectTransferStorage } from "./direct-transfer-storage.js";
import {
  type MultipartUploadRef,
  type StoredObjectChecksum,
  type StoredObjectHead,
  type UploadedPart,
  type WriteOnceUploadRequest,
} from "./direct-transfer-storage.js";
import {
  InMemoryObjectStorage,
  type SignedUpload,
} from "@dads-framework/object-storage-core";

type ReceivedPart = { readonly bytes: Uint8Array; readonly etag: string };

type OpenUpload = {
  readonly key: string;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly parts: Map<number, ReceivedPart>;
  readonly partByteSizes: Map<number, number>;
};

/**
 * Test driver: uploads and objects held in memory. A test plays the browser
 * with {@link InMemoryDirectTransferStorage.receivePart}; presigned URLs are
 * literal, inspectable `memory://` strings. Completed objects land in
 * `objects`, so an `ObjectStorage` reader handed the same instance sees them.
 */
export class InMemoryDirectTransferStorage implements DirectTransferStorage {
  private readonly uploads = new Map<string, OpenUpload>();
  private readonly metadataByKey = new Map<
    string,
    Readonly<Record<string, string>>
  >();
  private nextUploadNumber = 1;

  constructor(
    readonly objects: InMemoryObjectStorage = new InMemoryObjectStorage(),
  ) {}

  startMultipartUpload(input: {
    readonly key: string;
    readonly contentType: string;
    readonly metadata: Readonly<Record<string, string>>;
  }): Promise<MultipartUploadRef> {
    const storageUploadId = `memory-upload-${this.nextUploadNumber.toString()}`;
    this.nextUploadNumber += 1;
    this.uploads.set(storageUploadId, {
      key: input.key,
      contentType: input.contentType,
      metadata: { ...input.metadata },
      parts: new Map(),
      partByteSizes: new Map(),
    });
    return Promise.resolve({ key: input.key, storageUploadId });
  }

  presignUploadPart(
    input: MultipartUploadRef & {
      readonly partNumber: number;
      readonly byteSize?: number;
      readonly expiresInSeconds: number;
    },
  ): Promise<string> {
    if (input.byteSize !== undefined)
      this.findOpen(input)?.partByteSizes.set(input.partNumber, input.byteSize);
    return Promise.resolve(
      `memory://upload/${input.key}?uploadId=${input.storageUploadId}&partNumber=${input.partNumber.toString()}&expires=${input.expiresInSeconds.toString()}`,
    );
  }

  /** Plays the browser's PUT to a part URL and returns the part's ETag. */
  receivePart(
    upload: MultipartUploadRef,
    partNumber: number,
    bytes: Uint8Array,
  ): string {
    const open = this.findOpen(upload);
    if (!open) throw multipartError("NoSuchUpload");
    const expected = open.partByteSizes.get(partNumber);
    if (expected !== undefined && bytes.byteLength !== expected)
      throw multipartError("SignatureDoesNotMatch");
    const etag = `"${upload.storageUploadId}-${partNumber.toString()}-${bytes.byteLength.toString()}"`;
    open.parts.set(partNumber, { bytes, etag });
    return etag;
  }

  /** Whether the upload is still open — neither completed nor aborted. */
  isOpen(upload: MultipartUploadRef): boolean {
    return this.findOpen(upload) !== undefined;
  }

  listUploadedParts(
    upload: MultipartUploadRef,
  ): Promise<readonly UploadedPart[] | null> {
    const open = this.findOpen(upload);
    if (!open) return Promise.resolve(null);
    return Promise.resolve(
      [...open.parts.entries()]
        .sort(([left], [right]) => left - right)
        .map(([partNumber, part]) => ({
          partNumber,
          etag: part.etag,
          byteSize: part.bytes.byteLength,
        })),
    );
  }

  async completeMultipartUpload(
    input: MultipartUploadRef & {
      readonly parts: readonly Pick<UploadedPart, "partNumber" | "etag">[];
    },
  ): Promise<void> {
    const open = this.findOpen(input);
    if (!open) throw multipartError("NoSuchUpload");
    const chunks = input.parts.map((listed) => {
      const part = open.parts.get(listed.partNumber);
      if (!part || part.etag !== listed.etag)
        throw multipartError("InvalidPart");
      return part.bytes;
    });
    await this.objects.put(open.key, concatenate(chunks), open.contentType);
    this.metadataByKey.set(open.key, open.metadata);
    this.uploads.delete(input.storageUploadId);
  }

  abortMultipartUpload(upload: MultipartUploadRef): Promise<void> {
    if (this.findOpen(upload)) this.uploads.delete(upload.storageUploadId);
    return Promise.resolve();
  }

  async headObject(key: string): Promise<StoredObjectHead | null> {
    const stored = await this.objects.get(key);
    if (!stored) return null;
    return {
      byteSize: stored.body.byteLength,
      contentType: stored.contentType,
      metadata: this.metadataByKey.get(key) ?? {},
    };
  }

  async readObjectPrefix(
    key: string,
    byteCount: number,
  ): Promise<Uint8Array | null> {
    const stored = await this.objects.get(key);
    return stored ? stored.body.slice(0, byteCount) : null;
  }

  presignAttachmentDownload(input: {
    readonly key: string;
    readonly fileName: string;
    readonly expiresInSeconds: number;
  }): Promise<string> {
    return Promise.resolve(
      `memory://download/${input.key}?filename=${encodeURIComponent(input.fileName)}&expires=${input.expiresInSeconds.toString()}`,
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.objects.delete(key);
    this.metadataByKey.delete(key);
  }

  /** Writes nothing: a test plays the PUT by putting the bytes into `objects`. */
  presignWriteOnceUpload(input: WriteOnceUploadRequest): Promise<SignedUpload> {
    const checksum = Buffer.from(input.sha256, "hex").toString("base64");
    return Promise.resolve({
      url: `memory://write-once/${input.key}?bytes=${input.byteSize.toString()}&sha256=${input.sha256}&if-none-match=*&expires=${input.expiresInSeconds.toString()}`,
      headers: {
        "content-type": input.contentType,
        "content-length": String(input.byteSize),
        "x-amz-checksum-sha256": checksum,
        "if-none-match": "*",
      },
    });
  }

  async headObjectChecksum(key: string): Promise<StoredObjectChecksum | null> {
    const stored = await this.objects.get(key);
    if (!stored) return null;
    return {
      byteSize: stored.body.byteLength,
      sha256: createHash("sha256").update(stored.body).digest("hex"),
    };
  }

  private findOpen(upload: MultipartUploadRef): OpenUpload | undefined {
    const open = this.uploads.get(upload.storageUploadId);
    return open?.key === upload.key ? open : undefined;
  }
}
