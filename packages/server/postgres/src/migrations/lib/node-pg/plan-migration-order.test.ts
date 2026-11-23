import { describe, expect, it } from "vitest";
import { planMigrationOrder, type MigrationOrderEntry } from "./plan-migration-order.js";

const L = "20250101000000_legacy.migration";
const A = "20260101000000_alpha.migration";
const B = "20260101000001_beta.migration";
const C = "20260101000002_gamma.migration";
const names = (entries: readonly MigrationOrderEntry[]) => entries.map((entry) => entry.journalName);
const graph = (journalName: string, dependsOn: readonly string[] = []): MigrationOrderEntry => ({
  journalName,
  dependsOn,
});

describe("planMigrationOrder", () => {
  it("keeps an immutable legacy chain before all graph work", () => {
    expect(names(planMigrationOrder([graph(A), { journalName: L }]))).toEqual([L, A]);
  });

  it("accepts independent graph branches deployed in either order", () => {
    const entries = [graph(A), graph(B)];
    expect(names(planMigrationOrder(entries, [B]))).toEqual([B, A]);
    expect(names(planMigrationOrder(entries, [A]))).toEqual([A, B]);
  });

  it("orders a prerequisite before an earlier timestamp consumer", () => {
    expect(names(planMigrationOrder([graph(A, [B]), graph(B)]))).toEqual([B, A]);
  });

  it("refuses a dependent migration recorded before its prerequisite", () => {
    expect(() => planMigrationOrder([graph(A), graph(B, [A])], [B])).toThrow(
      expect.objectContaining({ code: "NODE_PG_MIGRATION_ORDER_DRIFT" }),
    );
  });

  it("refuses graph history missing the legacy barrier", () => {
    expect(() => planMigrationOrder([{ journalName: L }, graph(A)], [A])).toThrow(
      expect.objectContaining({ code: "NODE_PG_MIGRATION_ORDER_DRIFT" }),
    );
  });

  it("refuses an unknown applied migration", () => {
    expect(() => planMigrationOrder([graph(A)], [B])).toThrow(
      expect.objectContaining({ code: "NODE_PG_MIGRATION_DATABASE_AHEAD" }),
    );
  });

  it("refuses missing prerequisites even when all declared work was applied", () => {
    expect(() => planMigrationOrder([graph(A, [B])], [A])).toThrow(
      expect.objectContaining({ code: "NODE_PG_MIGRATION_DEPENDENCY_MISSING" }),
    );
  });

  it("refuses cycles and self-dependencies", () => {
    expect(() => planMigrationOrder([graph(A, [B]), graph(B, [A])])).toThrow(
      expect.objectContaining({ code: "NODE_PG_MIGRATION_DEPENDENCY_CYCLE" }),
    );
    expect(() => planMigrationOrder([graph(A, [A])])).toThrow(
      expect.objectContaining({ code: "NODE_PG_MIGRATION_DEPENDENCY_CYCLE" }),
    );
  });

  it("refuses duplicate identities, duplicate prerequisites and duplicate applied rows", () => {
    expect(() => planMigrationOrder([graph(A), graph(A)])).toThrow(
      expect.objectContaining({ code: "NODE_PG_MIGRATION_DUPLICATE" }),
    );
    expect(() => planMigrationOrder([graph(A), graph(B, [A, A])])).toThrow(
      expect.objectContaining({
        code: "NODE_PG_MIGRATION_DUPLICATE_DEPENDENCY",
      }),
    );
    expect(() => planMigrationOrder([graph(A)], [A, A])).toThrow(
      expect.objectContaining({ code: "NODE_PG_MIGRATION_JOURNAL_DUPLICATE" }),
    );
  });

  it("never replays already applied graph work", () => {
    const entries = [graph(A), graph(B), graph(C, [A, B])];
    expect(names(planMigrationOrder(entries, [B, A, C]))).toEqual([B, A, C]);
  });
});
