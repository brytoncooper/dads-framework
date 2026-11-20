/**
 * createObjectStorage picks the in-memory driver for tests and container-free
 * dev, and the disk driver for local persistence.
 */
import { describe, expect, it } from "vitest";

import { createDirectTransferStorage } from "./create-direct-transfer-storage.js";
import {
  createObjectStorage,
  type CreateObjectStorageOptions,
} from "./create-object-storage.js";
import { DiskObjectStorage } from "./disk-object-storage.js";
import { InMemoryDirectTransferStorage } from "./in-memory-direct-transfer-storage.js";
import { InMemoryObjectStorage } from "../core.js";

const DISK_OPTIONS: CreateObjectStorageOptions = {
  driver: "disk",
  rootDirectory: "/var/lib/example-app/data/files",
  signingKey: () => Promise.resolve(new Uint8Array(32)),
  publicPathPrefix: "/api/site/files",
  clock: () => new Date(),
  log: { warn: () => undefined },
};

describe("createObjectStorage", () => {
  it("returns the in-memory driver", () => {
    expect(createObjectStorage({ driver: "memory" })).toBeInstanceOf(
      InMemoryObjectStorage,
    );
  });

  it("returns the disk driver for a site, touching no disk", () => {
    expect(createObjectStorage(DISK_OPTIONS)).toBeInstanceOf(DiskObjectStorage);
  });

  it("builds no disk driver for direct transfers: the empty in-memory one stands in", () => {
    expect(createDirectTransferStorage(DISK_OPTIONS)).toBeInstanceOf(
      InMemoryDirectTransferStorage,
    );
  });
});
