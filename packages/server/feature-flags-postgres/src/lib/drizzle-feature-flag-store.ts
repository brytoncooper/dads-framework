import { and, count, desc, eq, inArray } from "drizzle-orm";

import { mintUuidV7 } from "@dads-framework/contract";
import {
  type FeatureFlagBatchWrite,
  type FeatureFlagHistoryEntry,
  type FeatureFlagHistoryPage,
  type FeatureFlagState,
  featureFlagBatchIdSchema,
  featureFlagStateSchema,
  FeatureFlagStore,
} from "@dads-framework/feature-flags";
import type { DrizzleHandle } from "@dads-framework/postgres";

import {
  featureFlagChangeEvents,
  featureFlagStates,
  featureFlagTenantTargets,
} from "./feature-flag-tables.js";

type Transaction = Parameters<Parameters<DrizzleHandle["transaction"]>[0]>[0];
type StateRow = Pick<
  typeof featureFlagStates.$inferSelect,
  | "id"
  | "slug"
  | "audienceMode"
  | "rowVersion"
  | "globalEnabledAt"
  | "updatedAt"
  | "updatedBy"
>;
type TargetRow = typeof featureFlagTenantTargets.$inferSelect;

class RevisionConflict extends Error {}

/**
 * The Postgres store. Each batch writes its states, their pilot tenants and
 * their history in one transaction; a stale revision rolls all of it back.
 */
export class DrizzleFeatureFlagStore extends FeatureFlagStore {
  constructor(private readonly db: DrizzleHandle) {
    super();
  }

  async listStates(
    slugs: readonly string[],
  ): Promise<readonly FeatureFlagState[]> {
    if (slugs.length === 0) return [];
    const rows = await this.db
      .select({
        id: featureFlagStates.id,
        slug: featureFlagStates.slug,
        audienceMode: featureFlagStates.audienceMode,
        rowVersion: featureFlagStates.rowVersion,
        globalEnabledAt: featureFlagStates.globalEnabledAt,
        updatedAt: featureFlagStates.updatedAt,
        updatedBy: featureFlagStates.updatedBy,
      })
      .from(featureFlagStates)
      .where(inArray(featureFlagStates.slug, [...slugs]));
    if (rows.length === 0) return [];
    const targets = await this.db
      .select()
      .from(featureFlagTenantTargets)
      .where(
        inArray(
          featureFlagTenantTargets.featureFlagStateId,
          rows.map((row) => row.id),
        ),
      );
    return rows.map((row) =>
      toState(
        row,
        targets.filter((target) => target.featureFlagStateId === row.id),
      ),
    );
  }

  async listHistory(input: {
    readonly slug: string;
    readonly page: number;
    readonly perPage: number;
  }): Promise<FeatureFlagHistoryPage> {
    const rows = await this.db
      .select()
      .from(featureFlagChangeEvents)
      .where(eq(featureFlagChangeEvents.slug, input.slug))
      .orderBy(desc(featureFlagChangeEvents.revision))
      .limit(input.perPage)
      .offset((input.page - 1) * input.perPage);
    const [total] = await this.db
      .select({ value: count() })
      .from(featureFlagChangeEvents)
      .where(eq(featureFlagChangeEvents.slug, input.slug));
    return { rows: rows.map(toHistoryEntry), total: total?.value ?? 0 };
  }

  async applyBatch(
    input: FeatureFlagBatchWrite,
  ): Promise<"applied" | "revision-conflict"> {
    try {
      await this.db.transaction(async (tx) => {
        for (const next of input.nextStates) {
          await writeStateWithTargets(tx, next, input.expectedRevisions);
        }
        await insertHistory(tx, input.history);
      });
      return "applied";
    } catch (error) {
      if (error instanceof RevisionConflict) return "revision-conflict";
      throw error;
    }
  }
}

function toState(
  row: StateRow,
  targets: readonly TargetRow[],
): FeatureFlagState {
  return featureFlagStateSchema.parse({
    slug: row.slug,
    audienceMode: row.audienceMode,
    revision: row.rowVersion,
    rememberedTenants: targets.map((target) => ({
      tenantId: target.tenantId,
      tenantName: target.tenantName,
      enabledAt: target.enabledAt?.toISOString() ?? null,
    })),
    globalEnabledAt: row.globalEnabledAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  });
}

function toHistoryEntry(
  row: typeof featureFlagChangeEvents.$inferSelect,
): FeatureFlagHistoryEntry {
  return {
    batchId: featureFlagBatchIdSchema.parse(row.batchId),
    slug: row.slug,
    revision: row.revision,
    previousState: featureFlagStateSchema.parse(row.previousState),
    nextState: featureFlagStateSchema.parse(row.nextState),
    ...(row.note === null ? {} : { note: row.note }),
    changedAt: row.changedAt.toISOString(),
    changedBy: row.changedBy,
  };
}

async function writeStateWithTargets(
  tx: Transaction,
  next: FeatureFlagState,
  expectedRevisions: ReadonlyMap<string, number>,
): Promise<void> {
  const expected = expectedRevisions.get(next.slug);
  if (expected === undefined) throw new RevisionConflict();
  const stateId = await writeState(tx, next, expected);
  await tx
    .delete(featureFlagTenantTargets)
    .where(eq(featureFlagTenantTargets.featureFlagStateId, stateId));
  if (next.rememberedTenants.length === 0) return;
  await tx.insert(featureFlagTenantTargets).values(
    next.rememberedTenants.map((tenant) => ({
      id: mintUuidV7(),
      featureFlagStateId: stateId,
      tenantId: tenant.tenantId,
      tenantName: tenant.tenantName,
      enabledAt: tenant.enabledAt === null ? null : new Date(tenant.enabledAt),
    })),
  );
}

/** The columns an insert and a revision update both write. */
function stateColumns(next: FeatureFlagState) {
  if (next.updatedAt === null || next.updatedBy === null) {
    throw new Error(`A written state for ${next.slug} must say who and when`);
  }
  return {
    audienceMode: next.audienceMode,
    globalEnabledAt:
      next.globalEnabledAt === null ? null : new Date(next.globalEnabledAt),
    updatedAt: new Date(next.updatedAt),
    updatedBy: next.updatedBy,
    rowVersion: next.revision,
  };
}

/** Revision 0 means "no row yet": insert, and lose to a concurrent first write. */
async function writeState(
  tx: Transaction,
  next: FeatureFlagState,
  expected: number,
): Promise<string> {
  const rows =
    expected === 0
      ? await tx
          .insert(featureFlagStates)
          .values({ id: mintUuidV7(), slug: next.slug, ...stateColumns(next) })
          .onConflictDoNothing({ target: featureFlagStates.slug })
          .returning({ id: featureFlagStates.id })
      : await tx
          .update(featureFlagStates)
          .set(stateColumns(next))
          .where(
            and(
              eq(featureFlagStates.slug, next.slug),
              eq(featureFlagStates.rowVersion, expected),
            ),
          )
          .returning({ id: featureFlagStates.id });
  const row = rows[0];
  if (row === undefined) throw new RevisionConflict();
  return row.id;
}

async function insertHistory(
  tx: Transaction,
  history: readonly FeatureFlagHistoryEntry[],
): Promise<void> {
  if (history.length === 0) return;
  await tx.insert(featureFlagChangeEvents).values(
    history.map((entry) => ({
      id: mintUuidV7(),
      batchId: entry.batchId,
      slug: entry.slug,
      revision: entry.revision,
      previousState: entry.previousState,
      nextState: entry.nextState,
      note: entry.note ?? null,
      changedAt: new Date(entry.changedAt),
      changedBy: entry.changedBy,
    })),
  );
}
