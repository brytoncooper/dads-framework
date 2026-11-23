import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkInvariants, createDiskWorld, render } from "./check-invariants.mjs";

const ROUTE_SOURCE = [
  'import { parseRequest } from "@dads-framework/http";',
  "",
  "export type RouteDefinition = { readonly tag: string };",
  "",
  "export function executeRoute(): void {",
  "  function deniedOutcome(): void {}",
  "  deniedOutcome();",
  "}",
  "",
  "export class TokenBucket {",
  "  consume(): void {",
  "    this.#refill();",
  "  }",
  "  #refill(): void {}",
  "}",
  "",
].join("\n");

const ROUTE_TEST = [
  'import { describe, it } from "vitest";',
  "",
  'describe("route behavior", () => {',
  '  it("refuses an unauthenticated request", () => {});',
  "  for (const failure of []) {",
  "    it(`rejects ${failure}`, () => {});",
  "  }",
  '  it.each([])("refuses %s outright", () => {});',
  "});",
  "",
].join("\n");

const PLAN_RUST = ["pub fn build_plan() {}", "", "#[test]", "fn a_zero_job_limit_is_refused() {}", ""].join("\n");

/**
 * The smallest workspace the gate reads: one package with an `INVARIANTS.md`,
 * one TypeScript module, its test, and a Rust file cited from the repository
 * root. `entries` are written verbatim, so a test says exactly what it feeds in.
 */
function createWorkspace(t, entries) {
  const root = mkdtempSync(join(tmpdir(), "dads-check-invariants-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (path, text) => {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("packages/server/http/src/execute-route.ts", ROUTE_SOURCE);
  write("packages/server/http/src/route-behavior.test.ts", ROUTE_TEST);
  write("packages/server/http/package.json", "{}\n");
  write("crates/planner/src/plan.rs", PLAN_RUST);
  write("packages/server/http/INVARIANTS.md", `# HTTP invariants\n\n${entries.join("\n")}\n`);
  return checkInvariants(createDiskWorld(root));
}

function problems(result) {
  return result.failures.map((failure) => failure.problem);
}

test("every citation form the files use resolves", (t) => {
  const result = createWorkspace(t, [
    '- INV-HTTP-1: A route refuses an unauthenticated request — enforced by `src/execute-route.ts#executeRoute` and `#deniedOutcome`, proven by `src/route-behavior.test.ts` "refuses an unauthenticated request".',
    '- INV-HTTP-2: A bucket refills — enforced by `src/execute-route.ts#TokenBucket.consume` and `#refill`, proven by `src/route-behavior.test.ts` "route behavior".',
    '- INV-HTTP-3: A blueprint carries a tag — enforced by `src/execute-route.ts` (`RouteDefinition` requiring `tag`), proven by `src/route-behavior.test.ts` "rejects a missing tag" and "refuses an unknown kind outright".',
    "- INV-HTTP-4: An imported helper is enforcement where it is called — enforced by `src/execute-route.ts#parseRequest`.",
    "- INV-HTTP-5: A plan is finite — enforced by `crates/planner/src/plan.rs#build_plan`, proven by `crates/planner/src/plan.rs#a_zero_job_limit_is_refused`.",
  ]);

  assert.deepEqual(problems(result), []);
  assert.equal(result.entryCount, 5);
  assert.equal(result.citationCount, 22);
});

test("two entries sharing one id fail, naming where it was first declared", (t) => {
  const result = createWorkspace(t, [
    "- INV-HTTP-1: A route refuses — enforced by `src/execute-route.ts#executeRoute`.",
    "- INV-HTTP-1: A route also refuses — enforced by `src/execute-route.ts#deniedOutcome`.",
  ]);

  assert.deepEqual(problems(result), ["duplicate id, already declared in packages/server/http/INVARIANTS.md"]);
  assert.equal(result.failures[0].id, "INV-HTTP-1");
  assert.equal(result.failures[0].citation, null);
});

test("a cited file that does not exist fails", (t) => {
  const result = createWorkspace(t, [
    '- INV-HTTP-1: A route refuses — enforced by `src/execute-route.ts#executeRoute`, proven by `src/route-outcome.test.ts` "refuses an unauthenticated request".',
  ]);

  assert.deepEqual(problems(result), ["no such file"]);
  assert.equal(result.failures[0].citation, "`src/route-outcome.test.ts`");
  assert.equal(result.failures[0].id, "INV-HTTP-1");
});

test("a cited symbol the file does not declare fails", (t) => {
  const result = createWorkspace(t, [
    "- INV-HTTP-1: A route refuses — enforced by `src/execute-route.ts#executeRouteOnce`.",
  ]);

  assert.deepEqual(problems(result), ["packages/server/http/src/execute-route.ts declares no executeRouteOnce"]);
});

test("a cited test name the file does not use fails", (t) => {
  const result = createWorkspace(t, [
    '- INV-HTTP-1: A route refuses — enforced by `src/execute-route.ts#executeRoute`, proven by `src/route-behavior.test.ts` "refuses an unauthenticated call".',
  ]);

  assert.deepEqual(problems(result), ["packages/server/http/src/route-behavior.test.ts names no such test"]);
  assert.equal(result.failures[0].citation, '`src/route-behavior.test.ts` "refuses an unauthenticated call"');
});

test("a symbol cited against a file that declares none fails", (t) => {
  const result = createWorkspace(t, ["- INV-HTTP-1: A package is declared — enforced by `package.json#name`."]);

  assert.deepEqual(problems(result), ["a .json file declares no symbols"]);
});

test("a Rust test cited by a quoted name fails", (t) => {
  const result = createWorkspace(t, [
    '- INV-HTTP-1: A plan is finite — enforced by `crates/planner/src/plan.rs#build_plan`, proven by `crates/planner/src/plan.rs` "a zero job limit is refused".',
  ]);

  assert.deepEqual(problems(result), ["a Rust test is cited as crates/planner/src/plan.rs#<fn>, not by a quoted name"]);
});

test("a bullet with no invariant id is a parse failure naming its text", (t) => {
  const result = createWorkspace(t, ["- The compiler plan is trusted SQL text plus values."]);

  assert.equal(result.entryCount, 0);
  assert.match(result.failures[0].problem, /line 3: bullet is not an invariant/);
  assert.match(result.failures[0].problem, /The compiler plan is trusted SQL/);
  assert.equal(result.failures[0].id, null);
});

test("an entry with no clause, no file, or no proof file is a parse failure", (t) => {
  const result = createWorkspace(t, [
    "- INV-HTTP-1: Every tuple read is scoped by a namespace.",
    "- INV-HTTP-2: A route refuses — enforced by the `executeRoute` contract.",
    "- INV-HTTP-3: A route refuses — enforced by `src/execute-route.ts`, proven by the contract tests.",
  ]);

  assert.deepEqual(problems(result), [
    'INV-HTTP-1: carries no "enforced by" clause',
    'INV-HTTP-2: "enforced by" names no file',
    'INV-HTTP-3: "proven by" names no file',
  ]);
});

test("a wrapped entry is read as one entry", (t) => {
  const result = createWorkspace(t, [
    "- INV-HTTP-1: A route refuses an unauthenticated request — enforced by",
    "  `src/execute-route.ts#executeRoute`, proven by",
    '  `src/route-behavior.test.ts` "refuses an unauthenticated request".',
  ]);

  assert.deepEqual(problems(result), []);
  assert.equal(result.entryCount, 1);
});

test("the human report ends with the counts, and --json says the same", (t) => {
  const clean = createWorkspace(t, [
    "- INV-HTTP-1: A route refuses — enforced by `src/execute-route.ts#executeRoute`.",
  ]);
  const broken = createWorkspace(t, ["- INV-HTTP-1: A route refuses — enforced by `src/execute-route.ts#gone`."]);

  assert.equal(render(clean, false), "invariants: 1 entries, 2 citations, ok\n");
  assert.equal(
    render(broken, false),
    "packages/server/http/INVARIANTS.md INV-HTTP-1: `src/execute-route.ts#gone`:" +
      " packages/server/http/src/execute-route.ts declares no gone\n" +
      "invariants: 1 entries, 2 citations, 1 failure\n",
  );
  assert.deepEqual(JSON.parse(render(broken, true)), {
    ok: false,
    failures: broken.failures,
    files: 1,
    entries: 1,
    citations: 2,
  });
});
