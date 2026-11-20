import { describe, expect, it } from "vitest";

import {
  postgresStorageSettings,
  testPostgresMemoryLimitGb,
  testPostgresStorage,
} from "./test-postgres-storage.js";

describe("testPostgresStorage", () => {
  it("defaults to disk when unset or empty", () => {
    expect(testPostgresStorage({})).toBe("disk");
    expect(testPostgresStorage({ TEST_POSTGRES_STORAGE: "" })).toBe("disk");
  });

  it("reads disk and ram", () => {
    expect(testPostgresStorage({ TEST_POSTGRES_STORAGE: "disk" })).toBe("disk");
    expect(testPostgresStorage({ TEST_POSTGRES_STORAGE: "ram" })).toBe("ram");
  });

  it("refuses any other value instead of silently using disk", () => {
    expect(() =>
      testPostgresStorage({ TEST_POSTGRES_STORAGE: "memory" }),
    ).toThrow(/must be "disk" or "ram"/);
  });
});

describe("postgresStorageSettings", () => {
  it("adds nothing on disk", () => {
    expect(postgresStorageSettings("disk")).toEqual([]);
  });

  it("turns durability off in ram", () => {
    expect(postgresStorageSettings("ram")).toEqual([
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
    ]);
  });
});

describe("testPostgresMemoryLimitGb", () => {
  it("caps the processes on disk, and adds the whole tmpfs in ram", () => {
    const onDisk = testPostgresMemoryLimitGb("disk", {});
    expect(onDisk).toBeGreaterThan(0);
    expect(testPostgresMemoryLimitGb("ram", {})).toBe(onDisk + 4);
  });

  it("reads an override in GB", () => {
    const env = { DADS_TEST_POSTGRES_MEMORY_GB: "1.5" };
    expect(testPostgresMemoryLimitGb("disk", env)).toBe(1.5);
    expect(testPostgresMemoryLimitGb("ram", env)).toBe(5.5);
  });

  it("refuses a limit of zero or nonsense", () => {
    for (const value of ["0", "-2", "big"]) {
      expect(() =>
        testPostgresMemoryLimitGb("disk", {
          DADS_TEST_POSTGRES_MEMORY_GB: value,
        }),
      ).toThrow(/DADS_TEST_POSTGRES_MEMORY_GB must be a number/);
    }
  });
});
