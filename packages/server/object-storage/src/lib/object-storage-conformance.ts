import { deepEqual, equal, ok } from "node:assert/strict";
import { createHash } from "node:crypto";

import type { ObjectStorage } from "./object-storage.js";

export type ObjectStorageConformanceCase = {
  readonly name: string;
  readonly run: (storage: ObjectStorage) => Promise<void>;
};

export const objectStorageConformance: readonly ObjectStorageConformanceCase[] = [
  {
    name: "preserves bytes and content type and reflects replacement",
    async run(storage) {
      const key = "object-conformance/round-trip";
      const bytes = new Uint8Array([0, 15, 255, 32]);
      await storage.put(key, bytes, "application/octet-stream");
      const first = await storage.get(key);
      ok(first);
      equal(first.contentType, "application/octet-stream");
      deepEqual([...first.body], [...bytes]);

      await storage.put(key, "changed", "text/plain");
      const updated = await storage.get(key);
      ok(updated);
      equal(updated.contentType, "text/plain");
      equal(new TextDecoder().decode(updated.body), "changed");
    },
  },
  {
    name: "lists every matching key and isolates unrelated prefixes",
    async run(storage) {
      const prefix = "object-conformance/list/";
      await storage.put(`${prefix}b`, "b", "text/plain");
      await storage.put(`${prefix}a`, "a", "text/plain");
      await storage.put("object-conformance/unrelated", "c", "text/plain");

      deepEqual((await storage.list(prefix)).sort(), [`${prefix}a`, `${prefix}b`]);
      deepEqual(await storage.list("object-conformance/empty/"), []);
    },
  },
  {
    name: "reports missing reads and accepts repeated deletion",
    async run(storage) {
      const key = "object-conformance/delete";
      equal(await storage.get(key), null);
      await storage.put(key, "bytes", "text/plain");
      await storage.delete(key);
      await storage.delete(key);

      equal(await storage.get(key), null);
    },
  },
  {
    name: "names a single upload and returns its type and length headers",
    async run(storage) {
      const body = "body";
      const upload = await storage.getSignedUpload("object-conformance/upload", {
        contentType: "text/plain",
        byteSize: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
        expiresInSeconds: 60,
      });

      ok(upload.url.length > 0);
      equal(upload.headers["content-type"], "text/plain");
      equal(upload.headers["content-length"], String(body.length));
    },
  },
];
