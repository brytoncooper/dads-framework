import { planMigrationOrder } from "../index.js";

export type CompatibilityMigration = {
  journalName: string;
  dependsOn?: readonly string[];
};

export type MigrationCompatibilityPlan = {
  baseline: readonly string[];
  orders: readonly (readonly string[])[];
};

export const MAX_COMPATIBILITY_ORDERS = 24;

export function planMigrationCompatibility(
  migrations: readonly CompatibilityMigration[],
  baselineNames: readonly string[],
): MigrationCompatibilityPlan {
  const baseline = new Set(baselineNames);
  const pending = planMigrationOrder(migrations, baselineNames).filter((entry) => !baseline.has(entry.journalName));
  if (pending.some((entry) => entry.dependsOn === undefined)) {
    throw new Error("pending migrations must declare prerequisites before rehearsal");
  }
  if (pending.length === 0) return { baseline: baselineNames, orders: [] };
  const orders: string[][] = [];
  enumerateOrders(pending, baseline, [], orders);
  return { baseline: baselineNames, orders };
}

function enumerateOrders(
  pending: readonly CompatibilityMigration[],
  applied: ReadonlySet<string>,
  prefix: readonly string[],
  orders: string[][],
): void {
  if (prefix.length === pending.length) {
    if (orders.length === MAX_COMPATIBILITY_ORDERS)
      throw new Error(
        `migration compatibility exceeds ${MAX_COMPATIBILITY_ORDERS} legal orders; split the batch or declare its real prerequisites before retrying`,
      );
    orders.push([...prefix]);
    return;
  }
  const eligible = pending
    .filter((entry) => !applied.has(entry.journalName) && (entry.dependsOn ?? []).every((name) => applied.has(name)))
    .sort((left, right) => left.journalName.localeCompare(right.journalName));
  if (eligible.length === 0) throw new Error("no valid migration compatibility order");
  for (const next of eligible)
    enumerateOrders(pending, new Set([...applied, next.journalName]), [...prefix, next.journalName], orders);
}
