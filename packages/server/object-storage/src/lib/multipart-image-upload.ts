import type {
  DirectTransferStorage,
  MultipartUploadRef,
  StoredObjectHead,
  UploadedPart,
} from "./direct-transfer-storage.js";
import type {
  ObjectStorage,
  StoredObject,
} from "@dads-framework/object-storage-core";

export type ImageMultipartReceipt = {
  readonly storageUploadId: string;
  readonly uploadUrl: string;
  readonly uploadUrlExpiresAt: string;
};

/** Bounded image transfers use one multipart part; domains own the quarantine key and publication. */
export class MultipartImageUpload {
  constructor(
    private readonly transfers: DirectTransferStorage,
    private readonly objects: ObjectStorage,
  ) {}

  async start(input: {
    readonly key: string;
    readonly contentType: string;
    readonly byteSize: number;
    readonly expiresAt: Date;
    readonly at: Date;
    readonly uploadUrlExpiresAt?: Date;
  }): Promise<ImageMultipartReceipt> {
    const upload = await this.transfers.startMultipartUpload({
      key: input.key,
      contentType: input.contentType,
      metadata: {
        "upload-byte-size": String(input.byteSize),
        "upload-expires-at": input.expiresAt.toISOString(),
      },
    });
    return {
      storageUploadId: upload.storageUploadId,
      uploadUrl: await this.transfers.presignUploadPart({
        ...upload,
        partNumber: 1,
        byteSize: input.byteSize,
        expiresInSeconds: Math.floor(
          ((input.uploadUrlExpiresAt ?? input.expiresAt).getTime() -
            input.at.getTime()) /
            1000,
        ),
      }),
      uploadUrlExpiresAt: (
        input.uploadUrlExpiresAt ?? input.expiresAt
      ).toISOString(),
    };
  }

  async finish(
    input: MultipartUploadRef & {
      readonly contentType: string;
      readonly maxBytes: number;
      readonly at: Date;
    },
  ): Promise<StoredObject | null> {
    const parts = await this.transfers.listUploadedParts(input);
    if (parts && !isOneBoundedPart(parts, input.maxBytes)) return null;
    if (parts)
      await this.transfers.completeMultipartUpload({ ...input, parts });
    const head = await this.transfers.headObject(input.key);
    if (
      !head ||
      !validImageHead(head, input.contentType, input.maxBytes, input.at)
    )
      return null;
    const stored = await this.objects.get(input.key);
    return stored?.body.byteLength === head.byteSize &&
      stored.contentType === head.contentType
      ? stored
      : null;
  }

  async discardAfterProcessing(input: MultipartUploadRef): Promise<void> {
    try {
      await this.discard(input);
    } catch {
      // Private quarantine has lifecycle expiry; cleanup must preserve the processing outcome.
    }
  }

  async discard(input: MultipartUploadRef): Promise<void> {
    await this.transfers.abortMultipartUpload(input);
    await this.transfers.deleteObject(input.key);
  }
}

function isOneBoundedPart(
  parts: readonly UploadedPart[],
  maxBytes: number,
): boolean {
  const [part] = parts;
  return (
    parts.length === 1 &&
    part?.partNumber === 1 &&
    part.byteSize > 0 &&
    part.byteSize <= maxBytes
  );
}

function validImageHead(
  head: StoredObjectHead,
  contentType: string,
  maxBytes: number,
  at: Date,
): boolean {
  const expectedSize = Number(head.metadata["upload-byte-size"]);
  const expiresAt = Date.parse(head.metadata["upload-expires-at"] ?? "");
  return (
    head.byteSize > 0 &&
    head.byteSize <= maxBytes &&
    head.contentType === contentType &&
    head.byteSize === expectedSize &&
    Number.isFinite(expiresAt) &&
    expiresAt > at.getTime()
  );
}
