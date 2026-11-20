import type { CreateObjectStorageOptions } from "./create-object-storage.js";
import type { DirectTransferStorage } from "./direct-transfer-storage.js";
import { InMemoryDirectTransferStorage } from "./in-memory-direct-transfer-storage.js";
import { S3DirectTransferStorage } from "./s3-direct-transfer-storage.js";

/**
 * Select the browser-direct transfer driver from the same options as
 * `createObjectStorage`. The memory driver cannot serve a real browser (its
 * URLs are `memory://`); dev slots run MinIO through the `s3` driver. The
 * site's `disk` driver gets its twin, `DiskDirectTransferStorage`, from the
 * composition root, over the same `DiskObjectStorage` instance, so
 * the two share one root, signing key and per-key write queue; called here
 * with `disk`, this answers the empty in-memory one.
 */
export function createDirectTransferStorage(
  options: CreateObjectStorageOptions,
): DirectTransferStorage {
  return options.driver === "s3"
    ? new S3DirectTransferStorage(options)
    : new InMemoryDirectTransferStorage();
}
