import { describe, expect, it } from "vitest";
import { migrationStatusFailure } from "./read-database-journal-status-result.js";

describe("migrationStatusFailure", () => {
  it("reports edited or missing recorded checksums as checksum failures", () => {
    expect(
      migrationStatusFailure({ code: "NODE_PG_MIGRATION_CHECKSUM_MISMATCH" }),
    ).toBe("checksum-mismatch");
    expect(
      migrationStatusFailure({ code: "NODE_PG_MIGRATION_CHECKSUM_MISSING" }),
    ).toBe("checksum-mismatch");
  });

  it("reports unknown applied state and protocol or dependency drift as unsafe history", () => {
    for (const code of [
      "NODE_PG_MIGRATION_DATABASE_AHEAD",
      "NODE_PG_MIGRATION_ORDER_DRIFT",
      "NODE_PG_MIGRATION_PROTOCOL_MISSING",
      "NODE_PG_MIGRATION_LEGACY_HISTORY_CHANGED",
    ]) {
      expect(migrationStatusFailure({ code })).toBe("database-ahead");
    }
  });

  it("leaves connection and malformed failures unavailable", () => {
    expect(migrationStatusFailure({ code: "ECONNREFUSED" })).toBeUndefined();
    expect(
      migrationStatusFailure(new Error("connection failed")),
    ).toBeUndefined();
    expect(migrationStatusFailure(null)).toBeUndefined();
  });
});
