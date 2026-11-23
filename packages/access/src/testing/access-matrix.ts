import type { PermissionQuery, SubjectRef } from "../runtime/authorization.js";
import type { MatrixDecision, PermissionMatrixSpec } from "./access-harness-types.js";
import { formatSubjectRef } from "./explain-format.js";

export type MatrixMismatch = {
  readonly actor: SubjectRef;
  readonly permissionName: string;
  readonly expected: MatrixDecision;
  readonly actual: MatrixDecision;
  readonly explanation?: string;
};

function padCell(text: string, width: number): string {
  return text.padEnd(width, " ");
}

function formatMatrixTable(spec: PermissionMatrixSpec, actualGrid: readonly (readonly MatrixDecision[])[]): string {
  const actorLabels = spec.cases.map(([actor]) => formatSubjectRef(actor));
  const actorColumnWidth = Math.max("actor".length, ...actorLabels.map((label) => label.length));
  const permWidths = spec.permissions.map((permission) =>
    Math.max(permission.permissionName.length, "allow (got deny)".length),
  );

  const headerCells = [
    padCell("actor", actorColumnWidth),
    ...spec.permissions.map((permission, index) => padCell(permission.permissionName, permWidths[index] ?? 10)),
  ];
  const lines = [headerCells.join(" | ")];
  lines.push(headerCells.map((cell) => "-".repeat(cell.length)).join("-+-"));

  for (let rowIndex = 0; rowIndex < spec.cases.length; rowIndex += 1) {
    const row = spec.cases[rowIndex];
    const actualRow = actualGrid[rowIndex] ?? [];
    if (row === undefined) continue;
    const [, expectedRow] = row;
    const cells = [padCell(actorLabels[rowIndex] ?? "", actorColumnWidth)];
    for (let colIndex = 0; colIndex < spec.permissions.length; colIndex += 1) {
      const expected = expectedRow[colIndex] ?? "deny";
      const actual = actualRow[colIndex] ?? "deny";
      const cellText = expected === actual ? actual : `${expected} (got ${actual})`;
      cells.push(padCell(cellText, permWidths[colIndex] ?? 10));
    }
    lines.push(cells.join(" | "));
  }

  return lines.join("\n");
}

/** Validate matrix shape and build a formatted assertion failure when any cell disagrees. */
export function buildMatrixFailureMessage(input: {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly spec: PermissionMatrixSpec;
  readonly actualGrid: readonly (readonly MatrixDecision[])[];
  readonly mismatches: readonly MatrixMismatch[];
}): string {
  const header = `Permission matrix failed for ${input.resourceType}:${input.resourceId} (${String(input.mismatches.length)} mismatch${input.mismatches.length === 1 ? "" : "es"}):`;
  const table = formatMatrixTable(input.spec, input.actualGrid);
  const details = input.mismatches.map((mismatch) => {
    const summary = `- ${formatSubjectRef(mismatch.actor)} on ${mismatch.permissionName}: expected ${mismatch.expected}, got ${mismatch.actual}`;
    return mismatch.explanation === undefined ? summary : `${summary}\n${mismatch.explanation}`;
  });
  return [header, "", table, "", ...details].join("\n");
}

/** Validate row lengths match the declared permission columns. */
export function validateMatrixSpec(spec: PermissionMatrixSpec): void {
  for (const [actor, expectedRow] of spec.cases) {
    if (expectedRow.length !== spec.permissions.length) {
      throw new Error(
        `Matrix row for ${formatSubjectRef(actor)} has ${String(expectedRow.length)} decisions, expected ${String(spec.permissions.length)}.`,
      );
    }
  }
}

/** Build a clear error message for a failed `assertVisible` check. */
export function buildVisibleFailureMessage(input: {
  readonly actor: SubjectRef;
  readonly resourceType: string;
  readonly permissionName: string;
  readonly expectedIds: readonly string[];
  readonly actualIds: readonly string[];
  readonly explain?: (query: PermissionQuery) => string;
}): string {
  const expectedSet = new Set(input.expectedIds);
  const actualSet = new Set(input.actualIds);
  const unexpected = input.actualIds.filter((id) => !expectedSet.has(id));
  const missing = input.expectedIds.filter((id) => !actualSet.has(id));

  const lines = [
    `Visible resources mismatch for ${formatSubjectRef(input.actor)} on ${input.resourceType}#${input.permissionName}:`,
    `  expected: [${input.expectedIds.join(", ")}]`,
    `  actual:   [${input.actualIds.join(", ")}]`,
  ];
  if (unexpected.length > 0) {
    lines.push(`  unexpectedly visible: [${unexpected.join(", ")}]`);
    for (const resourceId of unexpected.slice(0, 3)) {
      if (input.explain === undefined) break;
      lines.push(
        input.explain({
          subject: input.actor,
          resource: { type: input.resourceType, id: resourceId },
          permission: input.permissionName,
        }),
      );
    }
  }
  if (missing.length > 0) {
    lines.push(`  missing:              [${missing.join(", ")}]`);
    for (const resourceId of missing.slice(0, 3)) {
      if (input.explain === undefined) break;
      lines.push(
        input.explain({
          subject: input.actor,
          resource: { type: input.resourceType, id: resourceId },
          permission: input.permissionName,
        }),
      );
    }
  }
  return lines.join("\n");
}
