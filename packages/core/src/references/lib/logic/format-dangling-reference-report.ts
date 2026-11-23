/**
 * Turns findings into the lines an operator reads. Pure — the formatting is
 * where a reconciliation report either becomes actionable or becomes noise, so
 * it is testable without a database.
 */
import type {
  CrossDomainReference,
  DanglingReferenceFinding,
} from "../cross-domain-reference.js";

/** The clean-run line, so "it ran and found nothing" is never silence. */
export function formatCleanReport(checkedReferences: number): string {
  return `cross-domain reference integrity: ${String(checkedReferences)} references checked, no dangling values`;
}

/** One block per finding, worst first, each naming its ADR-0023 class. */
export function formatDanglingReferenceReport(
  findings: readonly DanglingReferenceFinding[],
  checkedReferences: number,
): string {
  const ordered = [...findings].sort((left, right) => right.rows - left.rows);
  const danglingRows = ordered.reduce((total, one) => total + one.rows, 0);

  const header =
    `cross-domain reference integrity: ${String(checkedReferences)} references checked, ` +
    `${String(ordered.length)} broken, ${count(danglingRows, "dangling row")}`;

  return [header, ...ordered.map(formatFinding)].join("\n");
}

function formatFinding(finding: DanglingReferenceFinding): string {
  const { reference } = finding;
  return [
    `DANGLING ${describeReference(reference)}`,
    `  ${count(finding.rows, "row")}, ${count(finding.distinctValues, "distinct id")}, ${reference.classification}`,
    `  sample ids: ${finding.sampleIds.join(", ")}`,
  ].join("\n");
}

/** `1 row` / `3 rows` — a report an operator reads should read like English. */
function count(amount: number, noun: string): string {
  return `${String(amount)} ${noun}${amount === 1 ? "" : "s"}`;
}

/** `permission_grants.subject_id → permission_sets.id (access-management → access-management)`. */
function describeReference(reference: CrossDomainReference): string {
  return (
    `${reference.consumerTable}.${reference.consumerColumn} → ` +
    `${reference.providerTable}.${reference.providerColumn} ` +
    `(${reference.consumerDomain} → ${reference.providerDomain})`
  );
}
