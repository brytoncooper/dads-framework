/**
 * Reading the two tables directly, so a claim rests on the database rather than
 * on the surface that wrote to it.
 *
 * `inspectNamespace` returns the application state document and the
 * authorization relationship counts as one comparable value: `assert.deepEqual`
 * on two snapshots is how the proof says "nothing changed" about both stores at
 * once. `inspectAuthorizationOutbox` exists to prove a negative — a same-store
 * composition must never have created an outbox table.
 */

import assert from "node:assert/strict";
import { workbenchUser, workbenchWorkspace } from "../../apps/workbench/dist/access.js";
import { POSTGRES_WORKBENCH_STATE_TABLE } from "../../apps/workbench/dist/storage/postgres-workbench-schema.js";

export async function inspectNamespace(pool, namespace) {
  const stateResult = await pool.query({
    text: `SELECT document FROM ${POSTGRES_WORKBENCH_STATE_TABLE} WHERE namespace = $1`,
    values: [namespace],
  });
  const stateRow = stateResult.rows[0];
  assert.ok(stateRow, "The initialized Workbench state row is missing.");
  const document = parseDocument(stateRow.document);
  const relationshipResult = await pool.query({
    text: "SELECT count(*)::integer AS count FROM dad_authorization_relationship WHERE namespace = $1",
    values: [namespace],
  });
  const relationshipRow = relationshipResult.rows[0];
  assert.ok(relationshipRow, "The relationship count query returned no row.");
  const relationshipCount = relationshipRow.count;
  assert.equal(typeof relationshipCount, "number", "Postgres did not return a numeric relationship count.");
  const exactOwnerResult = await pool.query({
    text: "SELECT count(*)::integer AS count FROM dad_authorization_relationship WHERE namespace = $1 AND resource_kind = $2 AND relation = $3 AND subject_kind = $4 AND subject_id = $5 AND subject_relation = '' AND subject_is_wildcard = false",
    values: [
      namespace,
      workbenchWorkspace.wireName,
      workbenchWorkspace.relations.owner.wireName,
      workbenchUser.wireName,
      "alice",
    ],
  });
  const exactOwnerRow = exactOwnerResult.rows[0];
  assert.ok(exactOwnerRow, "The exact owner tuple count query returned no row.");
  const exactOwnerRelationshipCount = exactOwnerRow.count;
  assert.equal(
    typeof exactOwnerRelationshipCount,
    "number",
    "Postgres did not return a numeric exact owner tuple count.",
  );
  return {
    stateDocument: document,
    workspaceIds: document.workspaces.map((workspace) => workspace.id),
    workspaceDetails: document.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      description: workspace.description,
      updatedAt: workspace.updatedAt,
    })),
    relationshipCount,
    exactOwnerRelationshipCount,
    pendingAuthorizationChanges: document.pendingAuthorizationChanges.length,
  };
}

function parseDocument(value) {
  const document = typeof value === "string" ? JSON.parse(value) : value;
  if (
    typeof document !== "object" ||
    document === null ||
    !("workspaces" in document) ||
    !("pendingAuthorizationChanges" in document) ||
    !Array.isArray(document.workspaces) ||
    !Array.isArray(document.pendingAuthorizationChanges)
  )
    throw new Error("Workbench state query returned an invalid JSONB document.");
  return document;
}

export async function inspectAuthorizationOutbox(pool) {
  const result = await pool.query({
    text: "SELECT to_regclass('public.dad_authorization_outbox') IS NOT NULL AS present",
  });
  const row = result.rows[0];
  assert.ok(row && typeof row.present === "boolean");
  return { tablePresent: row.present, pendingStateChanges: 0 };
}
