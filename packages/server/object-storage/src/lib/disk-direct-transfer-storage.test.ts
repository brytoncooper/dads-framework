/**
 * What: the disk twin of the browser-direct storage keeps open uploads and
 * their parts on the site's disk, assembles them into an object the disk
 * store reads back, and stores a part only for an unchanged signed link.
 * Why: at a plant with the internet cut, a task file or a service photo
 * uploads through the cloud's own flow. The bytes must survive a
 * restart, and a changed link must store nothing.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiskDirectTransferStorage } from "./disk-direct-transfer-storage.js";
import {
  type DiskFreeSpace,
  DiskObjectStorage,
} from "./disk-object-storage.js";
import type { SignedPartUploadQuery } from "./disk-part-links.js";

const PREFIX = "/api/site/files";
const KEY = "maintenance/uploads/o/f/site/task-file/t/u";

let root: string;
let now: Date;

function objects(
  freeSpace: DiskFreeSpace = () =>
    Promise.resolve({ freeBytes: 500 * 1024 ** 3, totalBytes: 1024 ** 4 }),
): DiskObjectStorage {
  return new DiskObjectStorage({
    rootDirectory: root,
    signingKey: () => Promise.resolve(new Uint8Array(32).fill(5)),
    publicPathPrefix: PREFIX,
    clock: () => now,
    // The floor has its own tests; this machine's disk is not the box's.
    freeSpace,
    log: { warn: () => undefined },
  });
}

/** The link's query, as the site's file route would read it. */
function queryOf(url: string): SignedPartUploadQuery {
  const params = new URL(url, "http://site.local").searchParams;
  const bytes = params.get("bytes");
  return {
    key: params.get("key") ?? "",
    upload: params.get("upload") ?? "",
    part: params.get("part") ?? "",
    ...(bytes === null ? {} : { bytes }),
    expires: params.get("expires") ?? "",
    sig: params.get("sig") ?? "",
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "disk-direct-transfer-"));
  now = new Date("2026-11-12T12:00:00.000Z");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("DiskDirectTransferStorage", () => {
  it("stores parts, completes them in order, and the disk store reads the object back", async () => {
    const store = objects();
    const transfers = new DiskDirectTransferStorage(store);
    const upload = await transfers.startMultipartUpload({
      key: KEY,
      contentType: "application/pdf",
      metadata: { "upload-id": "u" },
    });

    const second = await transfers.receivePart(
      queryOf(
        await transfers.presignUploadPart({
          ...upload,
          partNumber: 2,
          expiresInSeconds: 300,
        }),
      ),
      bytes("world"),
    );
    const first = await transfers.receivePart(
      queryOf(
        await transfers.presignUploadPart({
          ...upload,
          partNumber: 1,
          expiresInSeconds: 300,
        }),
      ),
      bytes("hello "),
    );
    expect(first).toMatchObject({ key: KEY, partNumber: 1, byteSize: 6 });
    expect(second).toMatchObject({ key: KEY, partNumber: 2, byteSize: 5 });

    const parts = await transfers.listUploadedParts(upload);
    expect(parts?.map((part) => part.partNumber)).toEqual([1, 2]);
    expect(parts?.map((part) => part.etag)).toEqual([
      first?.etag,
      second?.etag,
    ]);

    await transfers.completeMultipartUpload({ ...upload, parts: parts ?? [] });

    const stored = await store.get(KEY);
    expect(new TextDecoder().decode(stored?.body)).toBe("hello world");
    expect(stored?.contentType).toBe("application/pdf");
    expect(await transfers.headObject(KEY)).toEqual({
      byteSize: 11,
      contentType: "application/pdf",
      metadata: { "upload-id": "u" },
    });
    expect(await transfers.listUploadedParts(upload)).toBeNull();
  });

  it("refuses to complete with a part the disk does not hold as listed", async () => {
    const transfers = new DiskDirectTransferStorage(objects());
    const upload = await transfers.startMultipartUpload({
      key: KEY,
      contentType: "application/pdf",
      metadata: {},
    });
    await transfers.receivePart(
      queryOf(
        await transfers.presignUploadPart({
          ...upload,
          partNumber: 1,
          expiresInSeconds: 300,
        }),
      ),
      bytes("a"),
    );

    await expect(
      transfers.completeMultipartUpload({
        ...upload,
        parts: [{ partNumber: 1, etag: '"not-the-part"' }],
      }),
    ).rejects.toMatchObject({ name: "InvalidPart" });
    expect(await transfers.headObject(KEY)).toBeNull();
  });

  it("abort removes the parts and the open upload", async () => {
    const transfers = new DiskDirectTransferStorage(objects());
    const upload = await transfers.startMultipartUpload({
      key: KEY,
      contentType: "application/pdf",
      metadata: {},
    });
    await transfers.receivePart(
      queryOf(
        await transfers.presignUploadPart({
          ...upload,
          partNumber: 1,
          expiresInSeconds: 300,
        }),
      ),
      bytes("abc"),
    );

    await transfers.abortMultipartUpload(upload);

    expect(await transfers.listUploadedParts(upload)).toBeNull();
    expect(await readdir(join(root, "multipart"))).toEqual([]);
    // Aborting again succeeds: the upload is already gone.
    await expect(
      transfers.abortMultipartUpload(upload),
    ).resolves.toBeUndefined();
  });

  it("drops a part an abort overtook mid-write and answers as for a missing upload", async () => {
    let abortDuringWrite = (): Promise<void> => Promise.resolve();
    // The floor check sits between the open-upload check and the write, so
    // the abort lands exactly while the part is being written.
    const transfers = new DiskDirectTransferStorage(
      objects(async () => {
        await abortDuringWrite();
        return { freeBytes: 500 * 1024 ** 3, totalBytes: 1024 ** 4 };
      }),
    );
    const upload = await transfers.startMultipartUpload({
      key: KEY,
      contentType: "application/pdf",
      metadata: {},
    });
    const query = queryOf(
      await transfers.presignUploadPart({
        ...upload,
        partNumber: 1,
        expiresInSeconds: 300,
      }),
    );
    abortDuringWrite = () => transfers.abortMultipartUpload(upload);

    expect(await transfers.receivePart(query, bytes("abc"))).toBeNull();

    expect(await transfers.listUploadedParts(upload)).toBeNull();
    expect(await readdir(join(root, "multipart"))).toEqual([]);
  });

  it("survives a new instance on the same root: open uploads, parts and objects", async () => {
    const before = new DiskDirectTransferStorage(objects());
    const upload = await before.startMultipartUpload({
      key: KEY,
      contentType: "image/jpeg",
      metadata: { "upload-byte-size": "3" },
    });
    const url = await before.presignUploadPart({
      ...upload,
      partNumber: 1,
      byteSize: 3,
      expiresInSeconds: 300,
    });
    await before.receivePart(queryOf(url), bytes("jpg"));

    const after = new DiskDirectTransferStorage(objects());
    const parts = await after.listUploadedParts(upload);
    expect(parts).toHaveLength(1);
    await after.completeMultipartUpload({ ...upload, parts: parts ?? [] });

    const again = new DiskDirectTransferStorage(objects());
    expect(await again.headObject(KEY)).toEqual({
      byteSize: 3,
      contentType: "image/jpeg",
      metadata: { "upload-byte-size": "3" },
    });
    expect(await again.readObjectPrefix(KEY, 2)).toEqual(bytes("jp"));
  });

  it("stores nothing for a tampered, expired or wrong-size link, or an upload of another key", async () => {
    const transfers = new DiskDirectTransferStorage(objects());
    const upload = await transfers.startMultipartUpload({
      key: KEY,
      contentType: "image/jpeg",
      metadata: {},
    });
    const signed = queryOf(
      await transfers.presignUploadPart({
        ...upload,
        partNumber: 1,
        byteSize: 3,
        expiresInSeconds: 300,
      }),
    );

    const refused = [
      { ...signed, part: "2" },
      { ...signed, bytes: "4" },
      { ...signed, key: `${KEY}-other` },
      { ...signed, sig: "0".repeat(64) },
      { ...signed, upload: "../escape" },
    ];
    for (const query of refused)
      expect(await transfers.receivePart(query, bytes("abc"))).toBeNull();
    expect(await transfers.receivePart(signed, bytes("abcd"))).toBeNull();

    now = new Date(now.getTime() + 301_000);
    expect(await transfers.receivePart(signed, bytes("abc"))).toBeNull();

    expect(await transfers.listUploadedParts(upload)).toEqual([]);
  });

  it("deletes an object with its metadata", async () => {
    const transfers = new DiskDirectTransferStorage(objects());
    const upload = await transfers.startMultipartUpload({
      key: KEY,
      contentType: "application/pdf",
      metadata: { "upload-id": "u" },
    });
    await transfers.receivePart(
      queryOf(
        await transfers.presignUploadPart({
          ...upload,
          partNumber: 1,
          expiresInSeconds: 300,
        }),
      ),
      bytes("x"),
    );
    const parts = await transfers.listUploadedParts(upload);
    await transfers.completeMultipartUpload({ ...upload, parts: parts ?? [] });

    await transfers.deleteObject(KEY);

    expect(await transfers.headObject(KEY)).toBeNull();
    expect(await transfers.headObjectChecksum(KEY)).toBeNull();
  });
});
