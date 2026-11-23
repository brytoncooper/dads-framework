/**
 * Impurity inside `pure/` modules: ceiling 0.
 *
 * A `pure/` directory promises deterministic logic with no hidden I/O,
 * network, storage, framework runtime, or ambient clock/randomness reads.
 * Value imports of I/O or framework modules and calls to ambient nondeterminism
 * break that promise; `import type` and explicit parameters (`clock`, `new Date(timestamp)`)
 * keep it intact.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalEvidence, SignalReading, SignalReadings } from "../../doctor-signal.js";
import {
  type DoctorModule,
  evidenceAt,
  isProductionModule,
  moduleImports,
  packageOfSpecifier,
  ts,
  visitNodes,
} from "../scanners/typescript-program.js";

const PURE_DIRECTORY = /(?:^|\/)pure\//;
const EXCLUDED_TEST_SUFFIXES = [".spec.ts", ".spec.tsx", ".test-support.ts", ".test-support.tsx"];

const FORBIDDEN_NODE_BUILTINS = new Set([
  "fs",
  "http",
  "http2",
  "https",
  "net",
  "dgram",
  "dns",
  "tls",
  "child_process",
  "crypto",
  "worker_threads",
  "sqlite",
]);

const FORBIDDEN_PACKAGES = new Set([
  "pg",
  "drizzle-orm",
  "fastify",
  "better-auth",
  "resend",
  "bullmq",
  "@dads-framework/postgres",
  "@dads-framework/http",
  "@dads-framework/email",
  "@dads-framework/object-storage",
  "@dads-framework/job-queue",
  "@dads-framework/postgres-access",
  "@dads-framework/spicedb-access",
  "@dads-framework/sqlite-access",
  "@dads-framework/identity",
]);

const FORBIDDEN_GLOBAL_CALLS = new Set(["fetch", "setTimeout", "setInterval"]);
const FORBIDDEN_MEMBER_CALLS = new Set(["Date.now", "Math.random", "crypto.randomUUID", "performance.now"]);

function isPureProductionModule(path: string): boolean {
  if (!PURE_DIRECTORY.test(path)) return false;
  if (!isProductionModule(path)) return false;
  return !EXCLUDED_TEST_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

function isForbiddenImport(specifier: string): boolean {
  if (specifier.startsWith("node:")) {
    const builtin = specifier.slice("node:".length).split("/")[0] ?? "";
    return FORBIDDEN_NODE_BUILTINS.has(builtin);
  }
  const pkg = packageOfSpecifier(specifier);
  return FORBIDDEN_NODE_BUILTINS.has(pkg) || FORBIDDEN_PACKAGES.has(pkg);
}

function unwrapGlobal(expression: ts.Expression): ts.Expression {
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "globalThis"
  ) {
    return expression.name;
  }
  return expression;
}

function dynamicImportFinding(node: ts.CallExpression): string | undefined {
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
  if (!isDynamicImport && !isRequire) return undefined;
  const specifier = node.arguments[0];
  if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return undefined;
  return isForbiddenImport(specifier.text) ? `import ${specifier.text}` : undefined;
}

function callFinding(node: ts.CallExpression): string | undefined {
  const dynamicImport = dynamicImportFinding(node);
  if (dynamicImport !== undefined) return dynamicImport;

  const callee = unwrapGlobal(node.expression);
  if (ts.isIdentifier(callee) && FORBIDDEN_GLOBAL_CALLS.has(callee.text)) {
    return `${callee.text}()`;
  }
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const receiver = unwrapGlobal(node.expression.expression);
  if (!ts.isIdentifier(receiver)) return undefined;
  const pair = `${receiver.text}.${node.expression.name.text}`;
  return FORBIDDEN_MEMBER_CALLS.has(pair) ? `${pair}()` : undefined;
}

function ambientFinding(node: ts.Node): string | undefined {
  if (ts.isCallExpression(node)) return callFinding(node);
  if (ts.isNewExpression(node)) return newDateFinding(node);
  if (ts.isPropertyAccessExpression(node)) return processEnvPropertyFinding(node);
  if (ts.isElementAccessExpression(node)) return processEnvElementFinding(node);
  if (ts.isExternalModuleReference(node) && ts.isStringLiteral(node.expression)) {
    return isForbiddenImport(node.expression.text) ? `import ${node.expression.text}` : undefined;
  }
  return undefined;
}

function newDateFinding(node: ts.NewExpression): string | undefined {
  const target = unwrapGlobal(node.expression);
  if (!ts.isIdentifier(target) || target.text !== "Date") return undefined;
  const argCount = node.arguments?.length ?? 0;
  return argCount === 0 ? "new Date()" : undefined;
}

function processEnvPropertyFinding(node: ts.PropertyAccessExpression): string | undefined {
  const receiver = unwrapGlobal(node.expression);
  if (ts.isIdentifier(receiver) && receiver.text === "process" && node.name.text === "env") {
    return "process.env";
  }
  return undefined;
}

function processEnvElementFinding(node: ts.ElementAccessExpression): string | undefined {
  const receiver = unwrapGlobal(node.expression);
  if (
    ts.isIdentifier(receiver) &&
    receiver.text === "process" &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === "env"
  ) {
    return "process.env";
  }
  return undefined;
}

function scanPureModule(module: DoctorModule): SignalReading {
  const evidence: SignalEvidence[] = [];
  for (const entry of moduleImports(module)) {
    if (!entry.typeOnly && isForbiddenImport(entry.specifier)) {
      evidence.push(evidenceAt(module, entry.node, `import ${entry.specifier}`));
    }
  }
  visitNodes(module.source, (node) => {
    const found = ambientFinding(node);
    if (found !== undefined) {
      evidence.push(evidenceAt(module, node, found));
    }
  });
  return { value: evidence.length, evidence };
}

function countImpureCode(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    if (!isPureProductionModule(module.path)) continue;
    readings.set(module.path, scanPureModule(module));
  }
  return readings;
}

export const impureCodeSignal: DoctorSignal = {
  id: "impure-code",
  issue: "daddy-issues",
  question:
    "Does any production file inside a `pure/` directory import I/O or frameworks, or read ambient nondeterminism?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "Pure code does not sneak out to talk to the clock, the network, or the database.",
  run: (context) => Promise.resolve(countImpureCode(context)),
};
