import { describe, expect, it } from "vitest";
import { planMigrationCompatibility, type CompatibilityMigration } from "./plan-migration-compatibility.js";

const LEGACY = "20250101000000_baseline.migration";
const A = "20260101000000_alpha.migration";
const B = "20260102000000_beta.migration";
const C = "20260103000000_gamma.migration";
const legacy: CompatibilityMigration = { journalName: LEGACY };
const graph = (journalName: string, dependsOn: readonly string[] = []): CompatibilityMigration => ({
  journalName,
  dependsOn,
});

describe("migration compatibility schedules", () => {
  it("rehearses both arrival orders for independent additions", () => {
    expect(planMigrationCompatibility([legacy, graph(B), graph(A)], [LEGACY])).toEqual({
      baseline: [LEGACY],
      orders: [
        [A, B],
        [B, A],
      ],
    });
  });

  it("never schedules a prerequisite after its dependent", () => {
    expect(planMigrationCompatibility([legacy, graph(A), graph(B, [A])], [LEGACY])).toEqual({
      baseline: [LEGACY],
      orders: [[A, B]],
    });
  });

  it("covers both orientations of every unordered pair without factorial replay", () => {
    const migrations = [legacy, graph(A), graph(B), graph(C, [A])];
    const plan = planMigrationCompatibility(migrations, [LEGACY]);
    for (const order of plan.orders) {
      expect(order.indexOf(A)).toBeLessThan(order.indexOf(C));
      expect([...order].sort()).toEqual([A, B, C]);
    }
    for (const { left, right } of [
      { left: A, right: B },
      { left: B, right: C },
    ]) {
      expect(plan.orders.some((order) => order.indexOf(left) < order.indexOf(right))).toBe(true);
      expect(plan.orders.some((order) => order.indexOf(right) < order.indexOf(left))).toBe(true);
    }
    expect(plan.orders.length).toBeLessThanOrEqual(4);
  });

  it("refuses independent batches beyond the replay budget", () => {
    const additions = Array.from({ length: 30 }, (_, index) =>
      graph(`20260101${String(index).padStart(6, "0")}_entry.migration`),
    );
    expect(() => planMigrationCompatibility([legacy, ...additions], [LEGACY])).toThrow();
  });

  it("includes all six orders for three independent operations", () => {
    const plan = planMigrationCompatibility([legacy, graph(A), graph(B), graph(C)], [LEGACY]);
    expect(plan.orders).toHaveLength(6);
    expect(plan.orders).toContainEqual([A, C, B]);
    expect(plan.orders).toContainEqual([B, A, C]);
  });

  it("uses the exact deployed baseline without replaying its graph entries", () => {
    expect(planMigrationCompatibility([legacy, graph(A), graph(B, [A])], [LEGACY, A])).toEqual({
      baseline: [LEGACY, A],
      orders: [[B]],
    });
  });

  it("does not allocate work when there are no pending additions", () => {
    expect(planMigrationCompatibility([legacy], [LEGACY])).toEqual({
      baseline: [LEGACY],
      orders: [],
    });
  });

  it("refuses missing baseline history before rehearsal", () => {
    expect(() => planMigrationCompatibility([graph(A)], [LEGACY])).toThrow();
  });

  it("refuses a baseline with an already-applied prerequisite violation", () => {
    expect(() => planMigrationCompatibility([legacy, graph(A), graph(B, [A])], [LEGACY, B])).toThrow();
  });

  it("refuses unconverted legacy additions", () => {
    expect(() => planMigrationCompatibility([legacy, { journalName: A }], [LEGACY])).toThrow();
  });
});
