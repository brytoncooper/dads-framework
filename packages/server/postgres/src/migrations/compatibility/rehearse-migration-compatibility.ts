import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectPostgresClient } from "../../index.js";

import { discoverDomainMigrations, type MigrationWorkspace, runNodePgMigrations } from "../index.js";

import { planMigrationCompatibility } from "./plan-migration-compatibility.js";
import { readMigrationCompatibilityState } from "./read-migration-compatibility-state.js";
import { RehearsalSources } from "./rehearsal-sources.js";
import type { RehearsalPostgres } from "../../testing/index.js";

type CompatibilityState = Awaited<ReturnType<typeof readMigrationCompatibilityState>>;

export type MigrationCompatibilityResult = {
  orders: number;
  pending: number;
  baselineMs: number;
  replayMs: number;
  baselineRowsByRelation: Readonly<Record<string, number>>;
};

const NOTHING_PENDING: MigrationCompatibilityResult = {
  orders: 0,
  pending: 0,
  baselineMs: 0,
  replayMs: 0,
  baselineRowsByRelation: {},
};

/**
 * Applies the baseline once, then replays every arrival order of the pending
 * migrations on a copy of it, and refuses when two orders leave a different
 * schema or different retained data, or when any order changes cluster roles.
 */
export async function rehearseMigrationCompatibility(input: {
  workspace: MigrationWorkspace;
  baselineNames: readonly string[];
  postgres: RehearsalPostgres;
}): Promise<MigrationCompatibilityResult> {
  const migrations = await discoverDomainMigrations({
    workspace: input.workspace,
  });
  const plan = planMigrationCompatibility(migrations, input.baselineNames);
  if (plan.orders.length === 0) return NOTHING_PENDING;
  const sources = await RehearsalSources.read(input.workspace, migrations);
  const scratch = await mkdtemp(join(tmpdir(), "dads-migration-rehearsal-"));
  try {
    const started = performance.now();
    const baseline = await applyBaseline(input, sources, plan.baseline, scratch);
    const baselineMs = performance.now() - started;
    const replayStarted = performance.now();
    await replayEveryOrder(input, sources, plan, baseline, scratch);
    return {
      orders: plan.orders.length,
      pending: plan.orders[0]?.length ?? 0,
      baselineMs,
      replayMs: performance.now() - replayStarted,
      baselineRowsByRelation: Object.fromEntries(
        Object.entries(baseline.state.data).map(([name, result]) => [name, result.rows]),
      ),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

type RehearsalInput = {
  workspace: MigrationWorkspace;
  postgres: RehearsalPostgres;
};

type AppliedBaseline = {
  name: string;
  state: CompatibilityState;
  cluster: string;
};

async function applyBaseline(
  input: RehearsalInput,
  sources: RehearsalSources,
  baselineNames: readonly string[],
  scratch: string,
): Promise<AppliedBaseline> {
  const root = join(scratch, "baseline");
  await sources.prepareWorkspace(root);
  for (const name of baselineNames) await sources.addMigration(name, root);
  const database = await input.postgres.createDatabase();
  await runNodePgMigrations({
    databaseUrl: database.url,
    workspace: { ...input.workspace, root },
  });
  return {
    name: database.name,
    state: await readState(database.url),
    cluster: await input.postgres.clusterFingerprint(),
  };
}

async function replayEveryOrder(
  input: RehearsalInput,
  sources: RehearsalSources,
  plan: { baseline: readonly string[]; orders: readonly (readonly string[])[] },
  baseline: AppliedBaseline,
  scratch: string,
): Promise<void> {
  let reference: CompatibilityState | undefined;
  for (const [index, order] of plan.orders.entries()) {
    const root = join(scratch, `order-${index}`);
    await sources.prepareWorkspace(root);
    for (const name of plan.baseline) await sources.addMigration(name, root);
    const database = await input.postgres.createDatabase(baseline.name);
    for (const name of order) {
      await sources.addMigration(name, root);
      await runNodePgMigrations({
        databaseUrl: database.url,
        workspace: { ...input.workspace, root },
      });
    }
    if ((await input.postgres.clusterFingerprint()) !== baseline.cluster)
      throw new Error(
        "pending migrations change cluster roles/settings; use a dedicated fresh-cluster rehearsal before deployment",
      );
    const state = await readState(database.url);
    if (reference !== undefined && JSON.stringify(reference) !== JSON.stringify(state))
      throw new Error(
        `migration compatibility differs for arrival order ${order.join(" -> ")}; declare the actual prerequisite and verify retained data`,
      );
    reference = state;
  }
}

async function readState(databaseUrl: string): Promise<CompatibilityState> {
  const client = await connectPostgresClient(databaseUrl);
  try {
    return await readMigrationCompatibilityState(client);
  } finally {
    await client.end();
  }
}
