import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  bytesUnder,
  type DiskObjectHead,
  type DiskSpace,
  foldersToSync,
  fsyncFolder,
  fsyncFolderIfPresent,
  headOfFile,
  listFilesUnder,
  readIfPresent,
  readPrefixIfPresent,
  readSidecar,
  readVolumeSpace,
  sha256Hex,
  type SettledFile,
  type Sidecar,
  TEMP_MARKER,
  writeTemp,
} from "./disk-files.js";
import {
  type PartUploadLinkRequest,
  partLinkQueryString,
  partLinkValues,
  partNamedByQuery,
  partSignedFields,
  type SignedPartUpload,
  type SignedPartUploadQuery,
} from "./disk-part-links.js";
import { DiskReadinessProbe } from "./disk-readiness-probe.js";
import {
  ObjectStorage,
  type SignedUpload,
  type SignedUploadRequest,
  type StoredObject,
} from "@dads-framework/object-storage-core";

export {
  type DiskSpace,
  foldersToSync,
  loadOrCreateDiskSigningKey,
} from "./disk-files.js";

/** Reads the volume's space; `fs.statfs` on a box, a fixed answer in tests. */
export type DiskFreeSpace = (directory: string) => Promise<DiskSpace>;

/** The one log line shape the driver writes. Never the signing key. */
export type DiskObjectStorageLog = {
  warn(fields: Record<string, unknown>, message: string): void;
};

export type DiskObjectStorageOptions = {
  /** Objects live under `<rootDirectory>/objects/<key>`. */
  readonly rootDirectory: string;
  /**
   * The HMAC-SHA-256 key for signed links, made on the box and never logged.
   * Read once, on first use (`loadOrCreateDiskSigningKey` on a box).
   */
  readonly signingKey: () => Promise<Uint8Array>;
  /**
   * Where the site's file route answers, as an absolute URL on the origin the
   * browser reaches the site on, e.g. `https://site.example/api/site/files`.
   * Absolute because the response fields that carry a link are `z.url()`,
   * which refuses a path. A function is read each time a link is signed, so a
   * site with no fixed name can answer with the origin of the request in hand.
   */
  readonly publicPathPrefix: string | (() => string);
  readonly clock: () => Date;
  /** Defaults to `fs.statfs` on the root. */
  readonly freeSpace?: DiskFreeSpace;
  readonly log: DiskObjectStorageLog;
};

/** A signed download link's query values, as the file route received them. */
export type SignedDownloadQuery = {
  readonly key: string;
  readonly expires: string;
  readonly sig: string;
};

/** A signed upload as the file route received it: the link's query, the request's headers and body. */
export type ReceivedSignedUpload = SignedDownloadQuery & {
  readonly sha256: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly body: Uint8Array;
};

export type OpenedSignedDownload = {
  readonly object: StoredObject;
  /** Seconds the link has left. */
  readonly remainingSeconds: number;
};

/** A key that is absolute, climbs out, has an empty, `.` or `..` segment, a backslash or a NUL. */
export class InvalidObjectKey extends Error {
  override readonly name = "InvalidObjectKey";
  constructor(readonly key: string) {
    super("object key is not a plain relative path");
  }
}

/** The volume is below the floor; the put wrote nothing. */
export class SiteDiskLow extends Error {
  override readonly name = "SiteDiskLow";
  constructor(
    readonly freeBytes: number,
    readonly floorBytes: number,
  ) {
    super(
      `site disk low: ${freeBytes.toString()} bytes free, floor ${floorBytes.toString()}`,
    );
  }
}

const OBJECTS_FOLDER = "objects";
const SIDECAR_SUFFIX = ".meta.json";
const FLOOR_MIN_BYTES = 2 * 1024 ** 3;
const FLOOR_SHARE_OF_VOLUME = 0.05;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const UNIX_SECONDS = /^[0-9]{1,12}$/;
const WRITE_PROBE_INTERVAL_MS = 60_000;

/**
 * Site driver: each object is a file under `<root>/objects/<key>`, by the
 * same key the cloud uses, with a `<key>.meta.json` sidecar holding its
 * content type and SHA-256. A write is whole or absent (temp file, fsync,
 * rename, fsync the folder). Signed links are URLs on the site's own API
 * (`publicPathPrefix`), HMAC-signed with a key made on the box.
 */
export class DiskObjectStorage extends ObjectStorage {
  private readonly objectsDirectory: string;
  private readonly freeSpace: DiskFreeSpace;
  private signingKey: Promise<Uint8Array> | null = null;
  /** The latest put or delete per key; the next one (and any get) waits for it. */
  private readonly putsInFlight = new Map<string, Promise<void>>();
  private lastWriteProbe: {
    readonly at: number;
    readonly outcome: Promise<void>;
  } | null = null;
  private readonly readinessProbe: DiskReadinessProbe;

  constructor(private readonly options: DiskObjectStorageOptions) {
    super();
    this.objectsDirectory = join(options.rootDirectory, OBJECTS_FOLDER);
    this.freeSpace = options.freeSpace ?? readVolumeSpace;
    this.readinessProbe = new DiskReadinessProbe(options);
  }

  /**
   * Puts to one key run one after another in this process: two overlapping
   * puts could otherwise rename sidecar A, sidecar B, body B, body A and
   * leave body A under sidecar B, which reads as corrupt.
   */
  put(
    key: string,
    body: Uint8Array | string,
    contentType: string,
  ): Promise<void> {
    return this.queueForKey(key, () =>
      this.writeObject(key, body, contentType),
    );
  }

  /** Runs `change` after every put or delete already queued for the key. */
  private queueForKey(key: string, change: () => Promise<void>): Promise<void> {
    const previous = this.putsInFlight.get(key) ?? Promise.resolve();
    const next = previous.then(change, change);
    this.putsInFlight.set(key, next);
    const forget = () => {
      if (this.putsInFlight.get(key) === next) this.putsInFlight.delete(key);
    };
    next.then(forget, forget);
    return next;
  }

  private async writeObject(
    key: string,
    body: Uint8Array | string,
    contentType: string,
  ): Promise<void> {
    const path = this.pathOf(key);
    const bytes =
      typeof body === "string" ? new TextEncoder().encode(body) : body;
    await this.refuseBelowFloor(bytes.byteLength);
    const folder = dirname(path);
    const firstCreated = await mkdir(folder, { recursive: true });
    const sidecar: Sidecar = { contentType, sha256: sha256Hex(bytes) };
    const temps: string[] = [];
    try {
      const bodyTemp = await writeTemp(path, bytes, temps);
      const sidecarTemp = await writeTemp(
        path + SIDECAR_SUFFIX,
        new TextEncoder().encode(JSON.stringify(sidecar)),
        temps,
      );
      // The sidecar first: a cut between the two renames leaves the old
      // body under the new sidecar, which `get` answers as missing.
      await rename(sidecarTemp, path + SIDECAR_SUFFIX);
      await rename(bodyTemp, path);
    } finally {
      await Promise.all(temps.map((temp) => rm(temp, { force: true })));
    }
    // The file's folder, then each new folder's entry in its parent, so the
    // first file under a new folder survives a power cut too.
    for (const synced of foldersToSync(folder, firstCreated)) {
      await fsyncFolder(synced);
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    // A read between a put's two renames would see the new sidecar over the
    // old body: `settledSidecar` waits for the key's puts first.
    const found = await this.settledSidecar(key);
    if (found === null) return null;
    const body = await readIfPresent(found.path);
    if (body === null) return null;
    if (sha256Hex(body) !== found.sidecar.sha256) {
      this.options.log.warn(
        { event: "site.files.corrupt", key },
        "site file does not match its recorded SHA-256; answering missing",
      );
      return null;
    }
    return { body, contentType: found.sidecar.contentType };
  }

  /**
   * An object's size and content type from its directory entry and sidecar,
   * without reading the body (so no SHA-256 check, unlike `get`); null when
   * either is missing.
   */
  async head(key: string): Promise<DiskObjectHead | null> {
    const found = await this.settledSidecar(key);
    return found === null ? null : headOfFile(found.path, found.sidecar);
  }

  /**
   * An object's first `byteCount` bytes, reading only those from the file
   * (no SHA-256 check, unlike `get`); null when the object is missing.
   */
  async readPrefix(key: string, byteCount: number): Promise<Uint8Array | null> {
    const found = await this.settledSidecar(key);
    return found === null ? null : readPrefixIfPresent(found.path, byteCount);
  }

  /** The key's file path and sidecar once the key's puts finished, so never a half-renamed pair. */
  private async settledSidecar(key: string): Promise<SettledFile | null> {
    const path = this.pathOf(key);
    await this.putsInFlight.get(key)?.catch(() => undefined);
    const sidecar = await readSidecar(path + SIDECAR_SUFFIX);
    return sidecar === null ? null : { path, sidecar };
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    this.pathOf(key);
    const expires = this.expiryAfter(expiresInSeconds);
    const sig = await this.sign(["GET", key, expires]);
    const query = new URLSearchParams({ key, expires, sig });
    return `${this.publicPathPrefix()}?${query.toString()}`;
  }

  async getSignedUpload(
    key: string,
    request: SignedUploadRequest,
  ): Promise<SignedUpload> {
    this.pathOf(key);
    const expires = this.expiryAfter(request.expiresInSeconds);
    const sig = await this.sign(uploadSignedFields(key, expires, request));
    const query = new URLSearchParams({
      key,
      expires,
      sha256: request.sha256,
      sig,
    });
    return {
      url: `${this.publicPathPrefix()}?${query.toString()}`,
      headers: {
        "content-type": request.contentType,
        "content-length": String(request.byteSize),
      },
    };
  }

  /**
   * Queued with the key's puts, so a put queued before it never brings the
   * file back; the folder is fsynced so the delete survives a power cut.
   */
  delete(key: string): Promise<void> {
    return this.queueForKey(key, () => this.removeObject(key));
  }

  private async removeObject(key: string): Promise<void> {
    const path = this.pathOf(key);
    await rm(path, { force: true });
    await rm(path + SIDECAR_SUFFIX, { force: true });
    await fsyncFolderIfPresent(dirname(path));
  }

  /**
   * The bytes the objects folder holds now, bodies and sidecars: what a site
   * reports as its files' size in its check-in. It walks the whole folder,
   * so it is read once a minute, never per request.
   */
  storedBytes(): Promise<number> {
    return bytesUnder(this.objectsDirectory);
  }

  /** Walks only the folder the prefix names; sidecars and temp files are never keys. */
  async list(prefix: string): Promise<string[]> {
    const folderPart = prefix.slice(0, prefix.lastIndexOf("/") + 1);
    const segments = folderPart.split("/").filter((s) => s !== "");
    if (folderPart.startsWith("/") || segments.some(isUnsafeSegment)) {
      throw new InvalidObjectKey(prefix);
    }
    const found = await listFilesUnder(
      join(this.objectsDirectory, ...segments),
    );
    return found
      .map((relative) => folderPart + relative)
      .filter((key) => key.startsWith(prefix) && isObjectFileName(key))
      .sort();
  }

  /**
   * Opens a signed download link: null for a bad, expired or other-method
   * signature, a key outside the root, or a missing or corrupt file, so the
   * route answers all of them the same 404.
   */
  async readSignedDownload(
    query: SignedDownloadQuery,
  ): Promise<OpenedSignedDownload | null> {
    if (!isValidKey(query.key)) return null;
    const remainingSeconds = this.remainingSeconds(query.expires);
    if (remainingSeconds === null) return null;
    const signed = ["GET", query.key, query.expires];
    if (!(await this.signatureMatches(signed, query.sig))) return null;
    const object = await this.get(query.key);
    return object === null ? null : { object, remainingSeconds };
  }

  /**
   * Stores a signed upload only when the link, its expiry and the bytes all
   * match what was signed; anything else stores nothing.
   */
  async receiveSignedUpload(
    upload: ReceivedSignedUpload,
  ): Promise<"stored" | "refused"> {
    if (!isValidKey(upload.key) || !HEX_SHA256.test(upload.sha256))
      return "refused";
    if (this.remainingSeconds(upload.expires) === null) return "refused";
    const signed = uploadSignedFields(upload.key, upload.expires, upload);
    if (!(await this.signatureMatches(signed, upload.sig))) return "refused";
    if (upload.body.byteLength !== upload.byteSize) return "refused";
    if (sha256Hex(upload.body) !== upload.sha256) return "refused";
    await this.put(upload.key, upload.body, upload.contentType);
    return "stored";
  }

  /** The route's absolute URL as the request in hand reached it, or the fixed one. */
  private publicPathPrefix(): string {
    const { publicPathPrefix: prefix } = this.options;
    return typeof prefix === "function" ? prefix() : prefix;
  }

  /** The volume root; `DiskDirectTransferStorage` keeps open uploads beside `objects/`. */
  get rootDirectory(): string {
    return this.options.rootDirectory;
  }

  /**
   * A PUT link for one part of an open multipart upload kept on
   * this disk (`DiskDirectTransferStorage`). It names the key, the upload,
   * the part and, when given, the exact byte count, all signed, so a
   * browser can change none of them.
   */
  async getSignedPartUpload(part: PartUploadLinkRequest): Promise<string> {
    this.pathOf(part.key);
    const expires = this.expiryAfter(part.expiresInSeconds);
    const values = partLinkValues(part, expires);
    const sig = await this.sign(partSignedFields(values));
    return `${this.publicPathPrefix()}?${partLinkQueryString(values, sig)}`;
  }

  /**
   * The part a signed part link names; null for a bad, expired or changed
   * link, an upload id or part number out of shape, or a key outside the
   * root, so the route answers all of them the same 404.
   */
  async readSignedPartUpload(
    query: SignedPartUploadQuery,
  ): Promise<SignedPartUpload | null> {
    const part = partNamedByQuery(query);
    if (part === null || !isValidKey(query.key)) return null;
    if (this.remainingSeconds(query.expires) === null) return null;
    const fields = partSignedFields({ ...query, bytes: query.bytes ?? "" });
    if (!(await this.signatureMatches(fields, query.sig))) return null;
    return part;
  }

  /** Throws `SiteDiskLow` when `incomingBytes` would take the volume below the files floor. */
  ensureRoomFor(incomingBytes: number): Promise<void> {
    return this.refuseBelowFloor(incomingBytes);
  }

  /**
   * Readiness: reads the signing key (made here on a box's first start) and
   * runs the {@link DiskReadinessProbe}, so a full or read-only volume fails
   * readiness. It writes at most once a minute: readiness is
   * asked every few seconds, by anyone, so in between it answers the last
   * probe's outcome.
   */
  checkWritable(): Promise<void> {
    const now = this.options.clock().getTime();
    const last = this.lastWriteProbe;
    if (last !== null && now - last.at < WRITE_PROBE_INTERVAL_MS)
      return last.outcome;
    const outcome = this.probeWrite();
    // The cached outcome is awaited by each caller; this keeps a failed
    // probe from also counting as unhandled.
    outcome.catch(() => undefined);
    this.lastWriteProbe = { at: now, outcome };
    return outcome;
  }

  private async probeWrite(): Promise<void> {
    await this.key();
    await this.readinessProbe.run();
  }

  private pathOf(key: string): string {
    if (!isValidKey(key)) throw new InvalidObjectKey(key);
    return join(this.objectsDirectory, ...key.split("/"));
  }

  private async refuseBelowFloor(incomingBytes: number): Promise<void> {
    await mkdir(this.options.rootDirectory, { recursive: true });
    const space = await this.freeSpace(this.options.rootDirectory);
    const floorBytes = Math.max(
      FLOOR_MIN_BYTES,
      Math.ceil(space.totalBytes * FLOOR_SHARE_OF_VOLUME),
    );
    if (space.freeBytes - incomingBytes >= floorBytes) return;
    this.options.log.warn(
      { event: "site.files.disk_low", freeBytes: space.freeBytes, floorBytes },
      "site disk below the files floor; refusing a new file",
    );
    throw new SiteDiskLow(space.freeBytes, floorBytes);
  }

  private expiryAfter(expiresInSeconds: number): string {
    const nowSeconds = Math.floor(this.options.clock().getTime() / 1000);
    return String(nowSeconds + Math.max(0, Math.floor(expiresInSeconds)));
  }

  /** Seconds left before `expires`; null when it is malformed or already past. */
  private remainingSeconds(expires: string): number | null {
    if (!UNIX_SECONDS.test(expires)) return null;
    const nowSeconds = Math.floor(this.options.clock().getTime() / 1000);
    const remaining = Number(expires) - nowSeconds;
    return remaining > 0 ? remaining : null;
  }

  /** The signing key, read once; a failed read is tried again next time. */
  private key(): Promise<Uint8Array> {
    if (this.signingKey === null) {
      const loading = this.options.signingKey();
      this.signingKey = loading;
      loading.catch(() => {
        if (this.signingKey === loading) this.signingKey = null;
      });
    }
    return this.signingKey;
  }

  private async sign(fields: readonly string[]): Promise<string> {
    return createHmac("sha256", await this.key())
      .update(fields.join("\n"))
      .digest("hex");
  }

  private async signatureMatches(
    fields: readonly string[],
    received: string,
  ): Promise<boolean> {
    if (!HEX_SHA256.test(received)) return false;
    return timingSafeEqual(
      Buffer.from(await this.sign(fields), "hex"),
      Buffer.from(received, "hex"),
    );
  }
}

function uploadSignedFields(
  key: string,
  expires: string,
  request: Pick<SignedUploadRequest, "contentType" | "byteSize" | "sha256">,
): string[] {
  return [
    "PUT",
    key,
    expires,
    request.contentType,
    String(request.byteSize),
    request.sha256,
  ];
}

/** A plain relative key under the root that names an object, never a sidecar or temp file. */
export function isValidKey(key: string): boolean {
  if (key === "" || key.startsWith("/")) return false;
  if (key.includes("\\") || key.includes("\u0000")) return false;
  return !key.split("/").some(isUnsafeSegment) && isObjectFileName(key);
}

function isUnsafeSegment(segment: string): boolean {
  return (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.includes("\\") ||
    segment.includes("\u0000")
  );
}

/** A sidecar or a temp file is never an object. */
function isObjectFileName(key: string): boolean {
  const name = key.slice(key.lastIndexOf("/") + 1);
  return !name.endsWith(SIDECAR_SUFFIX) && !name.includes(TEMP_MARKER);
}
