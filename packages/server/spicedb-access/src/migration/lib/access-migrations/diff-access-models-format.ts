import type { AccessIrSubject, AccessIrTerm } from "@dads-framework/access";

import type {
  AccessModelBreakingChange,
  AccessModelSafeChange,
  PermissionChangeSummary,
} from "./diff-access-models.js";

export type DiffSummaryCounts = {
  readonly safe: readonly AccessModelSafeChange[];
  readonly breaking: readonly AccessModelBreakingChange[];
  readonly permissionChanges: readonly PermissionChangeSummary[];
};

export function formatBaseSubject(subject: AccessIrSubject): string {
  if (subject.kind === "type") return subject.wireName;
  if (subject.kind === "wildcard") return `${subject.wireName}:*`;
  return `${subject.wireName}#${subject.relation}`;
}

export function formatPermissionExpression(
  terms: readonly AccessIrTerm[],
): string {
  return terms.map(formatTerm).join(" + ");
}

export function canonicalPermissionKey(terms: readonly AccessIrTerm[]): string {
  return terms.map(canonicalTermKey).sort().join(" | ");
}

export function formatDiffSummary(
  counts: DiffSummaryCounts,
  requiresMigration: boolean,
): string {
  if (counts.safe.length === 0 && counts.breaking.length === 0) {
    return "No access model changes.";
  }
  const parts: string[] = [];
  if (counts.breaking.length > 0) {
    parts.push(
      `${counts.breaking.length} breaking change(s): ${counts.breaking.map(formatBreakingChange).join(", ")}`,
    );
  }
  if (counts.safe.length > 0) {
    parts.push(`${counts.safe.length} safe change(s)`);
  }
  if (counts.permissionChanges.length > 0) {
    parts.push(`${counts.permissionChanges.length} permission update(s)`);
  }
  const prefix = requiresMigration ? "Migration required" : "Safe change";
  return `${prefix}: ${parts.join("; ")}.`;
}

function formatTerm(term: AccessIrTerm): string {
  switch (term.kind) {
    case "role":
    case "permission":
      return term.name;
    case "through":
      return `${term.roleName}->${term.targetPermission}`;
    case "through-all":
      return `${term.roleName}.all(${term.targetPermission})`;
    case "gated":
      return `(${formatTerm(term.term)} & ${formatTerm(term.condition)})`;
    case "both":
      return `(${formatTerm(term.left)} & ${formatTerm(term.right)})`;
    case "excluding":
      return `(${formatTerm(term.term)} - ${formatTerm(term.banned)})`;
    case "or":
      return `(${term.terms.map(formatTerm).join(" + ")})`;
  }
}

function canonicalTermKey(term: AccessIrTerm): string {
  switch (term.kind) {
    case "role":
    case "permission":
      return `ref:${term.name}`;
    case "through":
      return `through:${term.roleName}->${term.targetPermission}`;
    case "through-all":
      return `through-all:${term.roleName}.all(${term.targetPermission})`;
    case "gated":
      return `both:(${canonicalTermKey(term.term)}&${canonicalTermKey(term.condition)})`;
    case "both":
      return `both:(${canonicalTermKey(term.left)}&${canonicalTermKey(term.right)})`;
    case "excluding":
      return `excluding:(${canonicalTermKey(term.term)}-${canonicalTermKey(term.banned)})`;
    case "or":
      return `or:(${term.terms.map(canonicalTermKey).sort().join("+")})`;
  }
}

function formatBreakingChange(change: AccessModelBreakingChange): string {
  switch (change.kind) {
    case "removed-resource":
      return `removed resource ${change.resource}`;
    case "removed-role":
      return `removed role ${change.resource}#${change.role}`;
    case "narrowed-role":
      return `narrowed ${change.resource}#${change.role} (removed ${change.subject})`;
    case "removed-expiration":
      return `removed expiration on ${change.resource}#${change.role} (${change.subject})`;
  }
}
