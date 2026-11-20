/**
 * What the lint configuration actually resolves to, one probe file per scope.
 *
 * A layered configuration — a base, a TypeScript layer, overrides for tests,
 * for type tests, for repository scripts — cannot be read to answer "which
 * rules apply here?". `eslint --print-config` answers it for one file, and one
 * probe file per scope is the whole of what either reading needs: which rules
 * this repository holds at `error`, and which it leaves at `warn`.
 *
 * Every probe has to resolve. If any of them cannot, the answer is nothing at
 * all rather than a partial set — a partial set reads as a pile of removed
 * rules to the floor, and as a clean repository to the ceiling. That is also
 * what keeps both readings quiet, and cheap, on a repository whose layout this
 * does not recognise.
 */

import { isRecord, isUnknownArray } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";

type LintProbe = {
  readonly scope: string;
  readonly path: string;
  readonly fallback?: RegExp;
};

const PROBES: readonly LintProbe[] = [
  { scope: "source", path: "packages/http/core/src/index.ts" },
  {
    scope: "test",
    path: "packages/http/core/src/index.test.ts",
    fallback: /^packages\/http\/core\/src\/.+\.test\.ts$/,
  },
  { scope: "type-tests", path: "packages/http/core/type-tests/route-cards.ts" },
  { scope: "scripts", path: "scripts/checks/check-docs.mjs" },
];

/** The severities a rule can be held at; anything else is off. */
export type LintSeverity = "error" | "warn";

const SEVERITY_NAMES: Readonly<Record<LintSeverity, number>> = {
  error: 2,
  warn: 1,
};

/** One scope's resolved rules, and the file they were resolved for. */
export type ResolvedLintScope = {
  readonly scope: string;
  readonly path: string;
  readonly rules: Readonly<Record<string, unknown>>;
};

/** Every probe scope's resolved rules, or nothing if any probe failed. */
export function resolveLintScopes(
  context: DoctorContext,
): readonly ResolvedLintScope[] {
  const resolved: ResolvedLintScope[] = [];
  for (const probe of PROBES) {
    const path = resolveProbe(context, probe);
    if (path === undefined) return [];
    const printed = context.exec("npx", ["eslint", "--print-config", path]);
    if (printed.status !== 0) return [];
    resolved.push({
      scope: probe.scope,
      path,
      rules: printedRules(printed.stdout),
    });
  }
  return resolved;
}

/** The rule names one scope holds at a severity, sorted. */
export function rulesAtSeverity(
  scope: ResolvedLintScope,
  severity: LintSeverity,
): readonly string[] {
  return Object.keys(scope.rules)
    .filter((rule) => isSeverity(scope.rules[rule], severity))
    .sort();
}

function resolveProbe(
  context: DoctorContext,
  probe: LintProbe,
): string | undefined {
  const files = context.files();
  if (files.includes(probe.path)) return probe.path;
  const fallback = probe.fallback;
  if (fallback === undefined) return undefined;
  return [...files].sort().find((path) => fallback.test(path));
}

function printedRules(
  printedConfig: string,
): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(printedConfig);
  const rules: unknown = isRecord(parsed) ? parsed["rules"] : undefined;
  return isRecord(rules) ? rules : {};
}

/** A severity is the level itself, or the first entry of its options array. */
function isSeverity(declared: unknown, severity: LintSeverity): boolean {
  if (isUnknownArray(declared)) return isSeverity(declared[0], severity);
  return declared === SEVERITY_NAMES[severity] || declared === severity;
}
