import { concatenate, multipartError } from "./multipart-assembly.js";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DirectTransferStorage,
  type MultipartUploadRef,
  type StoredObjectChecksum,
  type StoredObjectHead,
  type UploadedPart,
  type WriteOnceUploadRequest,
} from "./direct-transfer-storage.js";
import { foldersToSync, fsyncFolder, fsyncFolderIfPresent, readIfPresent, sha256Hex, writeTemp } from "./disk-files.js";
import { type DiskObjectStorage, InvalidObjectKey, isValidKey } from "./disk-object-storage.js";
import type { SignedPartUploadQuery } from "./disk-part-links.js";
import type { SignedUpload } from "../core.js";

/** One part a browser PUT to a signed part link, as the disk now holds it. */
export type ReceivedPart = {
  readonly key: string;
  readonly partNumber: number;
  readonly etag: string;
  readonly byteSize: number;
};

/** What an open upload fixes when it starts: never changed by a browser. */
type OpenUploadManifest = {
  readonly key: string;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
};

const MULTIPART_FOLDER = "multipart";
const OBJECT_METADATA_FOLDER = "object-metadata";
const MANIFEST_FILE = "upload.json";
const METADATA_SUFFIX = ".json";
const STORAGE_UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A part's file name is its number; a temp file (`<n>.tmp-…`) never matches. */
const PART_FILE = /^[1-9][0-9]{0,4}$/;

/**
 * The site's browser-direct twin of {@link DiskObjectStorage}, over
 * the same root and signing key, so the cloud's upload flow runs unchanged
 * at a plant with the internet cut.
 *
 * An open upload is a folder `<root>/multipart/<upload id>/` holding its
 * manifest (key, content type, metadata) and one file per part. A part link
 * is a path-only signed `PUT` on the site's own file route; the route hands
 * the bytes to {@link receivePart}. Completing assembles the parts, in
 * order, through `DiskObjectStorage.put` (temp file, fsync, rename, disk
 * floor), so `DiskObjectStorage.get` reads the object back, and keeps its
 * metadata beside it under `<root>/object-metadata/<key>.json`. Every write
 * is whole or absent and survives a restart: a new instance on the same
 * root sees every open upload and every object.
 */
export class DiskDirectTransferStorage extends DirectTransferStorage {
  private readonly multipartDirectory: string;
  private readonly metadataDirectory: string;

  constructor(private readonly objects: DiskObjectStorage) {
    super();
    this.multipartDirectory = join(objects.rootDirectory, MULTIPART_FOLDER);
    this.metadataDirectory = join(objects.rootDirectory, OBJECT_METADATA_FOLDER);
  }

  async startMultipartUpload(input: {
    readonly key: string;
    readonly contentType: string;
    readonly metadata: Readonly<Record<string, string>>;
  }): Promise<MultipartUploadRef> {
    if (!isValidKey(input.key)) throw new InvalidObjectKey(input.key);
    const storageUploadId = randomUUID();
    const manifest: OpenUploadManifest = {
      key: input.key,
      contentType: input.contentType,
      metadata: { ...input.metadata },
    };
    await writeWhole(join(this.uploadFolder(storageUploadId), MANIFEST_FILE), encodeJson(manifest));
    return { key: input.key, storageUploadId };
  }

  presignUploadPart(
    input: MultipartUploadRef & {
      readonly partNumber: number;
      readonly byteSize?: number;
      readonly expiresInSeconds: number;
    },
  ): Promise<string> {
    return this.objects.getSignedPartUpload(input);
  }

  /**
   * Stores one part a browser sent to a signed part link. Null, storing
   * nothing, for a bad, expired or changed link, an upload that is no
   * longer open (also when it was aborted while this part was written) or is
   * for another key, or a body whose size differs from the one the link names. Throws `SiteDiskLow` below the disk floor.
   */
  async receivePart(query: SignedPartUploadQuery, body: Uint8Array): Promise<ReceivedPart | null> {
    const part = await this.objects.readSignedPartUpload(query);
    if (part === null) return null;
    const manifest = await this.readManifest(part);
    if (manifest === null) return null;
    if (part.byteSize !== null && body.byteLength !== part.byteSize) return null;
    await this.objects.ensureRoomFor(body.byteLength);
    await writeWhole(join(this.uploadFolder(part.storageUploadId), String(part.partNumber)), body);
    // An abort that landed during the write removed the folder, and the
    // write made it again around this part alone: the upload is closed, so
    // drop what the write left and answer as for a missing upload.
    if ((await this.readManifest(part)) === null) {
      await this.removeUploadFolder(part.storageUploadId);
      return null;
    }
    return {
      key: part.key,
      partNumber: part.partNumber,
      etag: etagOf(body),
      byteSize: body.byteLength,
    };
  }

  async listUploadedParts(upload: MultipartUploadRef): Promise<readonly UploadedPart[] | null> {
    if ((await this.readManifest(upload)) === null) return null;
    const folder = this.uploadFolder(upload.storageUploadId);
    const names = (await readdir(folder)).filter((name) => PART_FILE.test(name));
    const parts: UploadedPart[] = [];
    for (const name of names) {
      const bytes = await readIfPresent(join(folder, name));
      if (bytes === null) continue;
      parts.push({
        partNumber: Number(name),
        etag: etagOf(bytes),
        byteSize: bytes.byteLength,
      });
    }
    return parts.sort((left, right) => left.partNumber - right.partNumber);
  }

  async completeMultipartUpload(
    input: MultipartUploadRef & {
      readonly parts: readonly Pick<UploadedPart, "partNumber" | "etag">[];
    },
  ): Promise<void> {
    const manifest = await this.readManifest(input);
    if (manifest === null) throw multipartError("NoSuchUpload");
    const folder = this.uploadFolder(input.storageUploadId);
    const chunks: Uint8Array[] = [];
    for (const listed of input.parts) {
      const bytes = await readIfPresent(join(folder, String(listed.partNumber)));
      if (bytes === null || etagOf(bytes) !== listed.etag) throw multipartError("InvalidPart");
      chunks.push(bytes);
    }
    // The metadata first: an object is never read without the metadata its
    // upload fixed. A cut between the two leaves only an unread file.
    await writeWhole(this.metadataPathOf(manifest.key), encodeJson(manifest.metadata));
    await this.objects.put(manifest.key, concatenate(chunks), manifest.contentType);
    await this.removeUploadFolder(input.storageUploadId);
  }

  async abortMultipartUpload(upload: MultipartUploadRef): Promise<void> {
    if (!STORAGE_UPLOAD_ID.test(upload.storageUploadId)) return;
    const manifest = await this.readManifest(upload);
    // An upload of another key is not this caller's to discard.
    if (manifest === null && (await this.hasManifest(upload))) return;
    await this.removeUploadFolder(upload.storageUploadId);
  }

  async headObject(key: string): Promise<StoredObjectHead | null> {
    const head = await this.objects.head(key);
    if (head === null) return null;
    return {
      byteSize: head.byteSize,
      contentType: head.contentType,
      metadata: await this.readMetadata(key),
    };
  }

  readObjectPrefix(key: string, byteCount: number): Promise<Uint8Array | null> {
    return this.objects.readPrefix(key, byteCount);
  }

  /** A signed `GET` on the site's own file route; the route answers the stored content type. */
  presignAttachmentDownload(input: {
    readonly key: string;
    readonly fileName: string;
    readonly expiresInSeconds: number;
  }): Promise<string> {
    return this.objects.getSignedUrl(input.key, input.expiresInSeconds);
  }

  async deleteObject(key: string): Promise<void> {
    await this.objects.delete(key);
    await rm(this.metadataPathOf(key), { force: true });
  }

  /**
   * The disk store's signed single `PUT`. It pins the byte count and the
   * SHA-256, so a second `PUT` to the link can only write the same bytes
   * again: nothing at the key can be replaced by other bytes.
   */
  presignWriteOnceUpload(input: WriteOnceUploadRequest): Promise<SignedUpload> {
    return this.objects.getSignedUpload(input.key, {
      contentType: input.contentType,
      byteSize: input.byteSize,
      sha256: input.sha256,
      expiresInSeconds: input.expiresInSeconds,
    });
  }

  async headObjectChecksum(key: string): Promise<StoredObjectChecksum | null> {
    const stored = await this.objects.get(key);
    if (stored === null) return null;
    return { byteSize: stored.body.byteLength, sha256: sha256Hex(stored.body) };
  }

  /** The upload's manifest when it is open and for this key; null otherwise. */
  private async readManifest(
    upload: Pick<MultipartUploadRef, "key" | "storageUploadId">,
  ): Promise<OpenUploadManifest | null> {
    if (!STORAGE_UPLOAD_ID.test(upload.storageUploadId)) return null;
    const bytes = await readIfPresent(join(this.uploadFolder(upload.storageUploadId), MANIFEST_FILE));
    const manifest = bytes === null ? null : decodeJson(bytes);
    return isManifest(manifest) && manifest.key === upload.key ? manifest : null;
  }

  private async hasManifest(upload: Pick<MultipartUploadRef, "storageUploadId">): Promise<boolean> {
    const bytes = await readIfPresent(join(this.uploadFolder(upload.storageUploadId), MANIFEST_FILE));
    return bytes !== null;
  }

  private async readMetadata(key: string): Promise<Readonly<Record<string, string>>> {
    const bytes = await readIfPresent(this.metadataPathOf(key));
    const metadata = bytes === null ? null : decodeJson(bytes);
    return isStringRecord(metadata) ? metadata : {};
  }

  private async removeUploadFolder(storageUploadId: string): Promise<void> {
    await rm(this.uploadFolder(storageUploadId), {
      recursive: true,
      force: true,
    });
    await fsyncFolderIfPresent(this.multipartDirectory);
  }

  /** Only ever called with an id `STORAGE_UPLOAD_ID` accepts, so it never names a path outside. */
  private uploadFolder(storageUploadId: string): string {
    if (!STORAGE_UPLOAD_ID.test(storageUploadId)) throw new InvalidObjectKey(storageUploadId);
    return join(this.multipartDirectory, storageUploadId);
  }

  private metadataPathOf(key: string): string {
    if (!isValidKey(key)) throw new InvalidObjectKey(key);
    return join(this.metadataDirectory, ...key.split("/")) + METADATA_SUFFIX;
  }
}

/** Temp file, fsync, rename, then fsync each folder the write made. */
async function writeWhole(path: string, bytes: Uint8Array): Promise<void> {
  const folder = dirname(path);
  const firstCreated = await mkdir(folder, { recursive: true });
  const temps: string[] = [];
  try {
    const temp = await writeTemp(path, bytes, temps);
    await rename(temp, path);
  } finally {
    await Promise.all(temps.map((temp) => rm(temp, { force: true })));
  }
  for (const synced of foldersToSync(folder, firstCreated)) {
    await fsyncFolder(synced);
  }
}

/** A part's ETag: its SHA-256, quoted as S3 quotes its ETags. */
function etagOf(bytes: Uint8Array): string {
  return `"${sha256Hex(bytes)}"`;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed;
  } catch {
    return null;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isManifest(value: unknown): value is OpenUploadManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    "key" in value &&
    typeof value.key === "string" &&
    "contentType" in value &&
    typeof value.contentType === "string" &&
    "metadata" in value &&
    isStringRecord(value.metadata)
  );
}
