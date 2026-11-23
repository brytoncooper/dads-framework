/** Formatting and canonicalization helpers for `dad access diff`. */

import type { AccessIrSubject, AccessIrTerm } from "@dads-framework/access";
import type {
  AccessDiffBreakingChange,
  AccessDiffSafeChange,
  AccessPermissionChangeSummary,
  AccessSchemaDiff,
} from "./access-diff-types.js";

export type AccessDiffSummaryCounts = {
  readonly safe: readonly AccessDiffSafeChange[];
  readonly breaking: readonly AccessDiffBreakingChange[];
  readonly permissionChanges: readonly AccessPermissionChangeSummary[];
};

export function formatBaseSubject(subject: AccessIrSubject): string {
  if (subject.kind === "type") return subject.wireName;
  if (subject.kind === "wildcard") return `${subject.wireName}:*`;
  return `${subject.wireName}#${subject.relation}`;
}

export function formatPermissionExpression(terms: readonly AccessIrTerm[]): string {
  return terms.map(formatTerm).join(" + ");
}

export function canonicalPermissionKey(terms: readonly AccessIrTerm[]): string {
  return terms.map(canonicalTermKey).sort().join(" | ");
}

export function formatAccessDiffSummary(counts: AccessDiffSummaryCounts, requiresMigration: boolean): string {
  if (counts.safe.length === 0 && counts.breaking.length === 0) {
    return "No access schema changes.";
  }
  const parts: string[] = [];
  if (counts.breaking.length > 0) {
    parts.push(`${counts.breaking.length} breaking change(s): ${counts.breaking.map(formatBreakingChange).join(", ")}`);
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

export function formatBreakingChange(change: AccessDiffBreakingChange): string {
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

export function formatSafeChange(change: AccessDiffSafeChange): string {
  switch (change.kind) {
    case "added-resource":
      return `added resource ${change.resource}`;
    case "added-role":
      return `added role ${change.resource}#${change.role}`;
    case "widened-role":
      return `widened ${change.resource}#${change.role} (added ${change.subject})`;
    case "added-expiration":
      return `added expiration on ${change.resource}#${change.role} (${change.subject})`;
    case "added-permission":
      return `added permission ${change.resource}#${change.permission} = ${change.expression}`;
    case "modified-permission":
      return `modified permission ${change.resource}#${change.permission}: ${change.before} -> ${change.after}`;
    case "removed-permission":
      return `removed permission ${change.resource}#${change.permission} (was ${change.before})`;
  }
}

export function formatAccessDiffReport(diff: AccessSchemaDiff): string {
  const lines: string[] = [diff.summary, `requiresMigration: ${diff.requiresMigration ? "true" : "false"}`];
  if (diff.breaking.length > 0) {
    lines.push("Breaking changes:");
    for (const entry of diff.breaking) {
      lines.push(`  - [${entry.kind}] ${formatBreakingChange(entry)}`);
    }
  }
  if (diff.safe.length > 0) {
    lines.push("Safe changes:");
    for (const entry of diff.safe) {
      lines.push(`  - [${entry.kind}] ${formatSafeChange(entry)}`);
    }
  }
  return `${lines.join("\n")}\n`;
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
