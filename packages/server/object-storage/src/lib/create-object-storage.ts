import {
  DiskObjectStorage,
  type DiskObjectStorageOptions,
} from "./disk-object-storage.js";
import { InMemoryObjectStorage, type ObjectStorage } from "../core.js";
import {
  S3ObjectStorage,
  type S3ObjectStorageOptions,
} from "./s3-object-storage.js";

export type CreateObjectStorageOptions =
  | { readonly driver: "memory" }
  | ({ readonly driver: "s3" } & S3ObjectStorageOptions)
  | ({ readonly driver: "disk" } & DiskObjectStorageOptions);

/** Select the in-memory, S3-compatible or site disk object-storage driver. */
export function createObjectStorage(
  options: CreateObjectStorageOptions,
): ObjectStorage {
  switch (options.driver) {
    case "s3":
      return new S3ObjectStorage(options);
    case "disk":
      return new DiskObjectStorage(options);
    case "memory":
      return new InMemoryObjectStorage();
  }
}
