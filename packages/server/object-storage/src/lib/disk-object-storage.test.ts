import { objectStorageConformance } from "./object-storage-conformance.js";
/**
 * What: the disk driver keeps each object as a file under its root, by the
 * same key the cloud uses, whole or not at all, and hands out signed,
 * path-only links its own route checks.
 * Why: local files must survive a restart, must never
 * name a path outside the root, and a wrong or half-written picture must
 * read as missing so the caller fetches it again.
 */
import { randomBytes } from "node:crypto";
import { readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DiskObjectStorage,
  foldersToSync,
  InvalidObjectKey,
  loadOrCreateDiskSigningKey,
  SiteDiskLow,
} from "./disk-object-storage.js";

import {
  advanceClock,
  GIB,
  logged,
  now,
  PLENTY,
  PREFIX,
  recordingLog,
  root,
  storage,
  storageOptions,
  prepareDiskObjectStorageFixture,
  removeDiskObjectStorageFixture,
} from "./disk-object-storage.test-support.js";

/** A promise a test opens by hand. */
function latch(): { promise: Promise<unknown>; resolve: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<unknown>((resolve) => {
    open = () => {
      resolve(null);
    };
  });
  return {
    promise,
    resolve: () => {
      open();
    },
  };
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true });
  return entries.sort();
}

beforeEach(prepareDiskObjectStorageFixture);
afterEach(removeDiskObjectStorageFixture);

describe("DiskObjectStorage", () => {
  it.each(objectStorageConformance)("$name", async ({ run }) => {
    await run(new DiskObjectStorage(storageOptions()));
  });

  it("round-trips an object with its content type, under <root>/objects/<key>", async () => {
    const files = storage();
    await files.put("facilities/f1/images/a.png", "png-bytes", "image/png");

    const stored = await files.get("facilities/f1/images/a.png");
    expect(stored?.contentType).toBe("image/png");
    expect(new TextDecoder().decode(stored?.body)).toBe("png-bytes");
    await expect(readFile(join(root, "objects", "facilities/f1/images/a.png"), "utf8")).resolves.toBe("png-bytes");
  });

  it("keeps an object across a new instance on the same root, as after a restart", async () => {
    await storage().put("a/b.txt", "kept", "text/plain");

    const stored = await storage().get("a/b.txt");
    expect(new TextDecoder().decode(stored?.body)).toBe("kept");
  });

  it("counts the bytes the objects folder holds, bodies and sidecars, and 0 before anything is stored", async () => {
    const files = storage();
    await expect(files.storedBytes()).resolves.toBe(0);

    await files.put("a/b.txt", "12345", "text/plain");
    await files.put("a/c/d.txt", "1234567890", "text/plain");

    const sidecars = await Promise.all(
      ["a/b.txt", "a/c/d.txt"].map((key) => readFile(join(root, "objects", `${key}.meta.json`))),
    );
    await expect(files.storedBytes()).resolves.toBe(
      15 + sidecars.reduce((total, sidecar) => total + sidecar.byteLength, 0),
    );
  });

  it("answers null for a key never stored", async () => {
    await expect(storage().get("nothing/here.png")).resolves.toBeNull();
  });

  it("lists the keys under a prefix, sorted, and only those", async () => {
    const files = storage();
    await files.put("builds/b.json", "{}", "application/json");
    await files.put("builds/a.json", "{}", "application/json");
    await files.put("builds/nested/c.json", "{}", "application/json");
    await files.put("releases/a.json", "{}", "application/json");

    await expect(files.list("builds/")).resolves.toEqual(["builds/a.json", "builds/b.json", "builds/nested/c.json"]);
    await expect(files.list("builds/a")).resolves.toEqual(["builds/a.json"]);
    await expect(files.list("missing/")).resolves.toEqual([]);
  });

  it("deletes the body and its sidecar, and succeeds when already gone", async () => {
    const files = storage();
    await files.put("a/b.txt", "x", "text/plain");

    await files.delete("a/b.txt");
    await files.delete("a/b.txt");

    await expect(files.get("a/b.txt")).resolves.toBeNull();
    await expect(filesUnder(join(root, "objects", "a"))).resolves.toEqual([]);
  });

  it.each([
    ["a `..` segment", "a/../../etc/passwd"],
    ["a `.` segment", "a/./b"],
    ["an absolute key", "/etc/passwd"],
    ["a backslash", "a\\..\\b"],
    ["a NUL", "a/b\u0000.png"],
    ["an empty segment", "a//b"],
    ["an empty key", ""],
    ["a trailing slash", "a/b/"],
    ["a sidecar's name", "a/b.meta.json"],
    ["a temp file's name", "a/b.tmp-123"],
  ])("refuses %s before touching the disk", async (_label, key) => {
    const files = storage();

    await expect(files.put(key, "x", "text/plain")).rejects.toBeInstanceOf(InvalidObjectKey);
    await expect(files.get(key)).rejects.toBeInstanceOf(InvalidObjectKey);
    await expect(files.delete(key)).rejects.toBeInstanceOf(InvalidObjectKey);
    await expect(files.getSignedUrl(key, 60)).rejects.toBeInstanceOf(InvalidObjectKey);
    await expect(filesUnder(root)).resolves.toEqual([]);
  });

  it("refuses a prefix that climbs out of the root", async () => {
    await expect(storage().list("../")).rejects.toBeInstanceOf(InvalidObjectKey);
  });

  it("answers null and logs site.files.corrupt (key only) when the body changed on disk", async () => {
    const files = storage();
    await files.put("a/b.png", "original", "image/png");
    await writeFile(join(root, "objects", "a/b.png"), "tampered");

    await expect(files.get("a/b.png")).resolves.toBeNull();
    expect(logged.map((line) => line.fields)).toEqual([{ event: "site.files.corrupt", key: "a/b.png" }]);
  });

  it("answers null when the sidecar is missing", async () => {
    const files = storage();
    await files.put("a/b.png", "bytes", "image/png");
    await rm(join(root, "objects", "a/b.png.meta.json"));

    await expect(files.get("a/b.png")).resolves.toBeNull();
  });

  it("heads an object from its file size and sidecar without reading the body", async () => {
    const files = storage();
    await files.put("a/b.png", "twelve-bytes", "image/png");
    await expect(files.head("a/b.png")).resolves.toEqual({
      byteSize: 12,
      contentType: "image/png",
    });

    // A body changed on disk is not read, so only its size shows.
    await writeFile(join(root, "objects", "a/b.png"), "tampered-longer");
    await expect(files.head("a/b.png")).resolves.toEqual({
      byteSize: 15,
      contentType: "image/png",
    });

    await expect(files.head("nothing/here.png")).resolves.toBeNull();
    await rm(join(root, "objects", "a/b.png.meta.json"));
    await expect(files.head("a/b.png")).resolves.toBeNull();
  });

  it("reads only the first bytes of an object, fewer for a short one, null when missing", async () => {
    const files = storage();
    await files.put("a/b.txt", "0123456789", "text/plain");

    const text = (bytes: Uint8Array | null): string | null => (bytes === null ? null : new TextDecoder().decode(bytes));
    expect(text(await files.readPrefix("a/b.txt", 4))).toBe("0123");
    expect(text(await files.readPrefix("a/b.txt", 100))).toBe("0123456789");
    expect(text(await files.readPrefix("a/b.txt", 0))).toBe("");
    expect(await files.readPrefix("nothing/here.txt", 4)).toBeNull();
    await rm(join(root, "objects", "a/b.txt.meta.json"));
    expect(await files.readPrefix("a/b.txt", 4)).toBeNull();
  });

  it("keeps the old object when a write stopped between the temp file and the rename", async () => {
    const files = storage();
    await files.put("a/b.png", "old", "image/png");
    // A power cut mid-put leaves only temp files beside the old object.
    await writeFile(join(root, "objects", "a/b.png.tmp-deadbeef"), "ne");
    await writeFile(join(root, "objects", "a/b.png.meta.json.tmp-deadbeef"), "{");

    const stored = await files.get("a/b.png");
    expect(new TextDecoder().decode(stored?.body)).toBe("old");
    await expect(files.list("a/")).resolves.toEqual(["a/b.png"]);
  });

  it("lets a get waiting on a replacing put read the new object, never a half-renamed pair", async () => {
    const held = latch();
    const checking = latch();
    let checks = 0;
    const files = storage(async () => {
      checks += 1;
      if (checks === 2) {
        checking.resolve();
        await held.promise;
      }
      return PLENTY("");
    });
    await files.put("a/b.png", "old", "image/png");

    const replacing = files.put("a/b.png", "new", "image/png");
    await checking.promise;
    const read = files.get("a/b.png");
    held.resolve();
    await replacing;

    const stored = await read;
    expect(new TextDecoder().decode(stored?.body)).toBe("new");
    expect(logged).toEqual([]);
  });

  it("runs a delete after the put queued before it, so the file stays deleted", async () => {
    const held = latch();
    const checking = latch();
    const files = storage(async () => {
      checking.resolve();
      await held.promise;
      return PLENTY("");
    });

    const putting = files.put("a/b.png", "bytes", "image/png");
    await checking.promise;
    const deleting = files.delete("a/b.png");
    held.resolve();
    await Promise.all([putting, deleting]);

    await expect(files.get("a/b.png")).resolves.toBeNull();
    await expect(filesUnder(join(root, "objects", "a"))).resolves.toEqual([]);
  });

  it("runs a put after the delete queued before it", async () => {
    const files = storage();
    await files.put("a/b.png", "old", "image/png");

    const deleting = files.delete("a/b.png");
    const putting = files.put("a/b.png", "new", "image/png");
    await Promise.all([deleting, putting]);

    const stored = await files.get("a/b.png");
    expect(new TextDecoder().decode(stored?.body)).toBe("new");
  });

  it("keeps a body under its own sidecar when puts to one key overlap", async () => {
    const files = storage();
    const bodies = Array.from({ length: 30 }, (_, n) => `body-${n.toString()}`);

    await Promise.all(bodies.map((body) => files.put("a/same.png", body, "image/png")));

    const stored = await files.get("a/same.png");
    expect(stored).not.toBeNull();
    expect(bodies).toContain(new TextDecoder().decode(stored?.body));
    expect(logged).toEqual([]);
  });

  it("starts a put to a key only after the one before it finished, so renames never interleave", async () => {
    const firstHeld = latch();
    const firstChecking = latch();
    const releaseFirst = () => {
      firstHeld.resolve();
    };
    const checks: string[] = [];
    const files = storage(async () => {
      checks.push(checks.length === 0 ? "first" : "later");
      if (checks.length === 1) {
        firstChecking.resolve();
        await firstHeld.promise;
      }
      return PLENTY("");
    });

    const first = files.put("a/same.png", "first", "image/png");
    await firstChecking.promise;
    const second = files.put("a/same.png", "second", "image/png");
    const other = files.put("a/other.png", "other", "image/png");
    await other;

    // The other key went ahead; the second put to a/same.png still waits.
    expect(checks).toEqual(["first", "later"]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(checks).toEqual(["first", "later", "later"]);
    const stored = await files.get("a/same.png");
    expect(new TextDecoder().decode(stored?.body)).toBe("second");
  });

  it("lets the next put to a key run after one that failed", async () => {
    let calls = 0;
    const files = storage(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve({ freeBytes: 0, totalBytes: 20 * GIB }) : PLENTY("");
    });

    await expect(files.put("a/b.png", "x", "image/png")).rejects.toBeInstanceOf(SiteDiskLow);
    await files.put("a/b.png", "y", "image/png");

    const stored = await files.get("a/b.png");
    expect(new TextDecoder().decode(stored?.body)).toBe("y");
  });

  it("leaves no temp file behind after a put", async () => {
    await storage().put("a/b.png", "bytes", "image/png");

    await expect(filesUnder(join(root, "objects", "a"))).resolves.toEqual(["b.png", "b.png.meta.json"]);
  });

  describe("disk floor", () => {
    it("refuses a put below 2 GB free, writes nothing and logs site.files.disk_low", async () => {
      const files = storage(() => Promise.resolve({ freeBytes: GIB, totalBytes: 20 * GIB }));

      const refused = files.put("a/b.png", "bytes", "image/png");
      await expect(refused).rejects.toBeInstanceOf(SiteDiskLow);
      await expect(filesUnder(root)).resolves.not.toContain(join("objects", "a", "b.png"));
      expect(logged.map((line) => line.fields)).toEqual([
        { event: "site.files.disk_low", freeBytes: GIB, floorBytes: 2 * GIB },
      ]);
    });

    it("uses 5 % of the volume when that is more than 2 GB", async () => {
      // 5 % of 100 GiB is 5 GiB, so 4 GiB free is below the floor.
      const files = storage(() => Promise.resolve({ freeBytes: 4 * GIB, totalBytes: 100 * GIB }));

      await expect(files.put("a/b.png", "bytes", "image/png")).rejects.toBeInstanceOf(SiteDiskLow);
    });

    it("refuses a body that would itself take the disk below the floor", async () => {
      const files = storage(() => Promise.resolve({ freeBytes: 2 * GIB + 3, totalBytes: 20 * GIB }));

      await expect(files.put("a/b.png", "four", "image/png")).rejects.toBeInstanceOf(SiteDiskLow);
    });
  });

  describe("checkWritable", () => {
    it("writes at most once a minute, answering the last outcome in between", async () => {
      // The root starts as a file, so the first probe fails.
      const target = join(root, "files");
      await writeFile(target, "x");
      const files = new DiskObjectStorage({
        rootDirectory: target,
        signingKey: () => Promise.resolve(new Uint8Array(32)),
        publicPathPrefix: PREFIX,
        clock: () => now,
        freeSpace: PLENTY,
        log: recordingLog(),
      });
      await expect(files.checkWritable()).rejects.toThrow();
      await rm(target);

      advanceClock(59_000);
      await expect(files.checkWritable()).rejects.toThrow();
      await expect(filesUnder(root)).resolves.toEqual([]);

      advanceClock(2_000);
      await expect(files.checkWritable()).resolves.toBeUndefined();
    });

    it("sweeps temp files a crash left more than 10 minutes ago, once, and nothing else", async () => {
      const files = storage();
      await files.put("a/b.png", "bytes", "image/png");
      const folder = join(root, "objects", "a");
      const stale = join(folder, "b.png.tmp-deadbeef");
      const staleSidecar = join(folder, "b.png.meta.json.tmp-deadbeef");
      const staleKey = join(root, "signing-key.tmp-deadbeef");
      const fresh = join(folder, "b.png.tmp-cafebabe");
      for (const path of [stale, staleSidecar, staleKey, fresh]) await writeFile(path, "half");
      const elevenMinutesAgo = new Date(now.getTime() - 11 * 60_000);
      for (const path of [stale, staleSidecar, staleKey]) await utimes(path, elevenMinutesAgo, elevenMinutesAgo);
      // The file's own clock: "fresh" was written just now.
      await utimes(fresh, now, now);

      await files.checkWritable();

      await expect(filesUnder(folder)).resolves.toEqual(["b.png", "b.png.meta.json", "b.png.tmp-cafebabe"]);
      await expect(filesUnder(root)).resolves.not.toContain("signing-key.tmp-deadbeef");
      expect(logged.map((line) => line.fields)).toEqual([{ event: "site.files.temp_swept", removed: 3 }]);

      // Once per process: a later probe does not sweep again.
      const later = join(folder, "b.png.tmp-0badf00d");
      await writeFile(later, "half");
      await utimes(later, elevenMinutesAgo, elevenMinutesAgo);
      advanceClock(61_000);
      await files.checkWritable();
      await expect(filesUnder(folder)).resolves.toContain("b.png.tmp-0badf00d");
    });

    it("writes and removes a probe, leaving nothing behind", async () => {
      await storage().checkWritable();

      await expect(filesUnder(root)).resolves.toEqual([]);
    });

    it("fails when the signing key cannot be read", async () => {
      const files = new DiskObjectStorage({
        rootDirectory: root,
        signingKey: () => Promise.reject(new Error("key unreadable")),
        publicPathPrefix: PREFIX,
        clock: () => now,
        freeSpace: PLENTY,
        log: recordingLog(),
      });

      await expect(files.checkWritable()).rejects.toThrow(/key unreadable/);
    });

    it("fails when the root cannot be written", async () => {
      const blocked = join(root, "a-file-not-a-folder");
      await writeFile(blocked, "x");
      const files = new DiskObjectStorage({
        rootDirectory: blocked,
        signingKey: () => Promise.resolve(new Uint8Array(32)),
        publicPathPrefix: PREFIX,
        clock: () => now,
        freeSpace: PLENTY,
        log: recordingLog(),
      });

      await expect(files.checkWritable()).rejects.toThrow();
    });
  });
});

describe("foldersToSync", () => {
  it("syncs only the file's folder when mkdir made none", () => {
    expect(foldersToSync("/r/objects/a/b", undefined)).toEqual(["/r/objects/a/b"]);
  });

  it("syncs the file's folder and every parent of a folder mkdir made", () => {
    // mkdir made /r/objects/a and /r/objects/a/b: their entries live in
    // /r/objects and /r/objects/a.
    expect(foldersToSync("/r/objects/a/b", "/r/objects/a")).toEqual(["/r/objects/a/b", "/r/objects/a", "/r/objects"]);
  });
});

describe("loadOrCreateDiskSigningKey", () => {
  it("makes 32 random bytes at <root>/signing-key, mode 0600, and reuses them", async () => {
    const first = await loadOrCreateDiskSigningKey(root);
    const second = await loadOrCreateDiskSigningKey(root);

    expect(first.byteLength).toBe(32);
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
    const mode = (await stat(join(root, "signing-key"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("makes the root when it does not exist yet", async () => {
    const nested = join(root, "data", "files");

    expect((await loadOrCreateDiskSigningKey(nested)).byteLength).toBe(32);
  });

  it("agrees on one whole key when many boots make it at once (first writer wins)", async () => {
    const keys = await Promise.all(Array.from({ length: 20 }, () => loadOrCreateDiskSigningKey(root)));

    const first = Buffer.from(keys[0] ?? new Uint8Array());
    expect(first.byteLength).toBe(32);
    for (const key of keys) expect(Buffer.from(key).equals(first)).toBe(true);
    await expect(readdir(root)).resolves.toEqual(["signing-key"]);
  });

  it("ignores a temp key a crash left behind", async () => {
    await writeFile(join(root, "signing-key.tmp-deadbeef"), randomBytes(5));

    expect((await loadOrCreateDiskSigningKey(root)).byteLength).toBe(32);
  });

  it("refuses a key file of the wrong length", async () => {
    await writeFile(join(root, "signing-key"), randomBytes(5));

    await expect(loadOrCreateDiskSigningKey(root)).rejects.toThrow(/signing-key/);
  });

  it("keeps the key out of objects/, so no key can name it", async () => {
    const files = storage();
    await loadOrCreateDiskSigningKey(root);

    await expect(files.list("")).resolves.toEqual([]);
  });
});
