import { sql, type SQL } from "drizzle-orm";

import type { AccessModel } from "@dads-framework/access";
import { describeScopePlan } from "@dads-framework/access/scopes";
import type { DrizzleHandle } from "@dads-framework/postgres";

import type { SubjectRef } from "@dads-framework/access/runtime";
import {
  answerScope,
  planScopedList,
  type ScopeLookups,
} from "@dads-framework/access/runtime";
import { scopePredicate } from "../lib/scoped-lists/scope-predicate.js";
import type { ScopeSqlBindings } from "../lib/scoped-lists/scope-sql-bindings.js";

/** What one subject's SQL scope and `lookupResources` disagree on. */
type Disagreement = {
  readonly subject: SubjectRef;
  /** Rows the SQL scope reads that SpiceDB does not let the subject see. */
  readonly onlyInSql: readonly string[];
  /** Records SpiceDB lets the subject see that the SQL scope misses. */
  readonly onlyInLookup: readonly string[];
};

/**
 * The proof every adopting model carries: over a seeded world, for each
 * subject, the ids `scopePredicate` selects equal (as a set) the ids
 * `lookupResources` returns. Throws one readable diff covering every subject
 * that disagrees, with the plan that was rendered.
 */
export async function proveScopeMatchesLookup(input: {
  readonly db: DrizzleHandle;
  readonly model: AccessModel;
  readonly authorization: ScopeLookups;
  readonly wireName: string;
  readonly permission: string;
  readonly sqlBindings: ScopeSqlBindings;
  readonly relatedSqlBindings?: readonly ScopeSqlBindings[];
  readonly subjects: readonly SubjectRef[];
}): Promise<void> {
  const plan = planScopedList(input.model, input.wireName, input.permission);
  const disagreements: Disagreement[] = [];

  for (const subject of input.subjects) {
    const answer = await answerScope({
      resourceType: input.wireName,
      permission: input.permission,
      plan,
      subject,
      lookups: input.authorization,
    });
    const scoped = await selectScopedIds(
      input.db,
      input.sqlBindings,
      scopePredicate(answer, input.sqlBindings, input.relatedSqlBindings),
    );
    const visible = new Set(
      await input.authorization.lookupResources({
        subject,
        permission: input.permission,
        resourceType: input.wireName,
      }),
    );
    const onlyInSql = [...scoped].filter((id) => !visible.has(id)).sort();
    const onlyInLookup = [...visible].filter((id) => !scoped.has(id)).sort();
    if (onlyInSql.length > 0 || onlyInLookup.length > 0) {
      disagreements.push({ subject, onlyInSql, onlyInLookup });
    }
  }

  if (disagreements.length > 0) {
    throw new Error(
      [
        `scope filter for ${input.wireName}.${input.permission} disagrees with lookupResources`,
        `  plan: ${describeScopePlan(plan)}`,
        ...disagreements.flatMap(describeDisagreement),
      ].join("\n"),
    );
  }
}

async function selectScopedIds(
  db: DrizzleHandle,
  bindings: ScopeSqlBindings,
  predicate: SQL,
): Promise<ReadonlySet<string>> {
  const result = await db.execute(
    sql`SELECT ${bindings.id} AS id FROM ${bindings.table} WHERE ${predicate}`,
  );
  const ids = new Set<string>();
  for (const row of result.rows) {
    const id = row["id"];
    if (typeof id !== "string") {
      throw new Error(
        `${bindings.wireName} id column returned ${typeof id}, not a string`,
      );
    }
    ids.add(id);
  }
  return ids;
}

function describeDisagreement(disagreement: Disagreement): readonly string[] {
  const { subject } = disagreement;
  const name = `${subject.type}:${subject.id}${subject.relation === undefined ? "" : `#${subject.relation}`}`;
  return [
    `  ${name}`,
    ...(disagreement.onlyInSql.length === 0
      ? []
      : [
          `    SQL reads, SpiceDB denies: ${disagreement.onlyInSql.join(", ")}`,
        ]),
    ...(disagreement.onlyInLookup.length === 0
      ? []
      : [
          `    SpiceDB allows, SQL misses: ${disagreement.onlyInLookup.join(", ")}`,
        ]),
  ];
}
