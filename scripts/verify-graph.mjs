/**
 * Every proof `npm run verify` runs, and the one thing each of them waits for.
 *
 * The list is declared in the order the old `&&` chain ran, because `--serial`
 * replays that order exactly. `needs` is the real dependency and nothing more:
 * a step waits only for work whose output it reads. Weights are the measured
 * CPU a step keeps busy (`/usr/bin/time -p`, 15-core M5 Pro, 2026-09-06),
 * rounded up to whole slots; `"all"` marks a tool that owns a worker pool and
 * scales itself across the machine.
 *
 * Nothing here decides what is skipped. Locally, `verify-cache.mjs` skips a
 * step whose inputs are unchanged since it last passed, by the scope
 * `verify-cache-scopes.mjs` gives it; CI runs every step every time. The
 * saving the graph itself makes over the chain is that `tsc -b` is one node
 * instead of the two identical invocations `lint` and `typecheck` each opened.
 */

import { readdirSync } from "node:fs";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const NODE = process.execPath;
const TSC = "node_modules/typescript-native/bin/tsc";
const PRETTIER = "node_modules/prettier/bin/prettier.cjs";
const ESLINT = "node_modules/eslint/bin/eslint.js";

/**
 * Every `scripts/**\/*.test.mjs`, discovered and sorted, so a suite is in the
 * gate the day it is written. The chain listed seven soundness suites by name
 * and ran nothing else; fifteen suites under `scripts/adoption`,
 * `scripts/checks`, and `scripts/authorization` were run only by lane scripts
 * CI never called. None of them reads `dist`.
 */
const SCRIPT_TEST_FILES = discoverScriptTests();

function discoverScriptTests() {
  const scripts = fileURLToPath(new URL("../scripts", import.meta.url));
  return readdirSync(scripts, { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".test.mjs"))
    .map((path) => `scripts/${path}`)
    .sort();
}

export const VERIFY_STEPS = Object.freeze(
  [
    {
      id: "format",
      command: NODE,
      args: [PRETTIER, "--check", "."],
      needs: [],
      weight: 2, // 3.2 s wall, 1.9 cores: Prettier formats files on workers.
    },
    {
      id: "styles",
      command: NODE,
      args: ["--test", "packages/web/ui/styles/verify-styles.test.mjs"],
      needs: [],
      weight: 1,
    },
    {
      id: "private-references",
      command: NODE,
      args: ["scripts/checks/check-private-references.mjs"],
      needs: [],
      weight: 1,
    },
    {
      id: "build",
      command: NODE,
      args: [TSC, "-b", "--pretty", "false"],
      needs: [],
      weight: "all",
    },
    {
      id: "eslint",
      command: NODE,
      args: [ESLINT, ".", "--ignore-pattern", "target/**"],
      // Cargo can create and remove directories in the root build output.
      // The typed rules build the program from the same project references,
      // and `tsc -b` is what writes the `.d.ts` those references resolve to.
      needs: ["build"],
      weight: 2, // 9.4 s wall, 1.7 cores.
    },
    {
      id: "api-report",
      command: NODE,
      args: ["scripts/checks/generate-api-report.mjs", "--check"],
      // Reads every package's emitted declarations.
      needs: ["build"],
      weight: 2, // 1.9 s wall, 1.7 cores.
    },
    {
      id: "docs",
      command: NODE,
      args: ["scripts/checks/check-docs.mjs"],
      // Imports packages/testing/core/dist/dad-test-cli.js to read the real
      // `dad-test` command surface; without a build it fails, not skips.
      needs: ["build"],
      weight: 1,
    },
    {
      id: "markdown-links",
      command: NODE,
      args: ["scripts/checks/check-markdown-links.mjs"],
      needs: [],
      weight: 1,
    },
    {
      id: "test",
      command: NODE,
      // Vitest over the workspace, writing the JSON report `source-budgets`
      // reads; under the local verify cache it runs only the packages whose
      // inputs changed (`verify-test-step.mjs`).
      args: ["scripts/verify-test-step.mjs"],
      // Cross-package imports resolve to each package's `dist`.
      needs: ["build"],
      weight: "all",
    },
    {
      id: "script-tests",
      command: NODE,
      args: ["--test", ...SCRIPT_TEST_FILES],
      // Every suite imports sibling `.mjs` modules and writes under `tmpdir()`;
      // none of them touches `dist` or the working tree.
      needs: [],
      weight: 2, // 11.5 s wall, 1.2 cores: mostly waiting on child processes.
    },
    {
      id: "workbench-client",
      command: NODE,
      args: ["scripts/workbench/generate-workbench-client.mjs", "--check"],
      // Reads the built Workbench contract surface.
      needs: ["build"],
      weight: 1,
    },
    {
      id: "dependency-boundaries",
      command: NODE,
      args: ["scripts/checks/check-dependency-boundaries.mjs"],
      // The `public-surface` gate reads emitted `.d.ts` and *skips* a package
      // that has no `dist`. Waiting for the build is what keeps it a gate.
      needs: ["build"],
      weight: 1,
    },
    {
      id: "test-types",
      command: NODE,
      args: ["scripts/checks/check-test-types.mjs"],
      // Compiles every test file under its own package's tsconfig; the
      // cross-package imports resolve through node_modules into `dist`.
      needs: ["build"],
      weight: 2, // 2.5 s wall, 8.4 s CPU across 23 short `tsc -p` runs.
    },
    {
      id: "invariants",
      command: NODE,
      args: ["scripts/checks/check-invariants.mjs"],
      // Reads tracked INVARIANTS.md, `.ts`, and `.rs` sources only, never
      // `dist`: every citation must name a real file, symbol, and test.
      needs: [],
      weight: 1, // 0.2 s wall; the CPU it shows is node's startup.
    },
    {
      id: "source-budgets",
      command: NODE,
      args: ["scripts/checks/check-source-budgets.mjs"],
      // The gate is `dad doctor --gate` behind a wrapper, so it needs the
      // toolbox's `dist`; `build` is named here rather than left implied by
      // `test`, because the reason it is needed is the wrapper and not the
      // report. The `testCount` floor reads the Vitest JSON report the test
      // step writes; a missing report reports "not measured", not a failure.
      needs: ["build", "test"],
      weight: 2, // 4.3 s wall, 1.5 cores: it runs every gated signal.
    },
    {
      id: "instruction-budgets",
      command: NODE,
      args: ["scripts/checks/check-instruction-budgets.mjs"],
      needs: [],
      weight: 1,
    },
    {
      id: "agent-benchmarks",
      command: NODE,
      args: ["scripts/checks/run-agent-benchmarks.mjs"],
      // Runs packages/foundation/toolbox/dist/cli.js once per benchmark task.
      needs: ["build"],
      weight: 1,
    },
  ].map((step) => Object.freeze({ ...step, needs: Object.freeze(step.needs) })),
);

/**
 * The proofs CI runs in its other jobs, added by `--full`: the adoption
 * proofs, the Rust gates, the engine build, the whole sealed corpus, and the
 * release evidence over it. Every one of them already spreads itself across
 * the machine, so each is weight `"all"`. The Rust steps chain because cargo
 * serializes on its target-directory lock anyway, and `rust-toolchain.toml`
 * pins the toolchain a bare `cargo` picks up.
 */
export const FULL_STEPS = Object.freeze(
  [
    {
      id: "adoption",
      command: NODE,
      args: ["scripts/adoption/verify-adoption.mjs"],
      // Packs the built packages, so it reads every package's `dist`.
      needs: ["build"],
      weight: "all",
    },
    {
      id: "rust-format",
      command: "cargo",
      args: ["fmt", "--all", "--check"],
      needs: [],
      weight: 1,
    },
    {
      id: "rust-lint",
      command: "cargo",
      args: ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
      needs: ["rust-format"],
      weight: "all",
    },
    {
      id: "rust-test",
      command: "cargo",
      args: ["test", "--workspace"],
      needs: ["rust-lint"],
      weight: "all",
    },
    {
      id: "engine",
      command: "cargo",
      args: ["build", "-p", "dad-test"],
      // A debug engine runs the corpus in the same time as a release one and
      // compiles in a fraction of it; CI builds the same way.
      needs: ["rust-test"],
      weight: "all",
    },
    {
      id: "corpus",
      command: NODE,
      args: [
        "scripts/testing/testing-soundness.mjs",
        "--dad-test",
        "target/debug/dad-test",
        "--output",
        "target/soundness.json",
      ],
      // The fixture symlinks the repository's node_modules and runs oxlint,
      // the compiler, and Vitest on its own sources; it never reads `dist`.
      needs: ["engine"],
      weight: "all",
    },
    {
      id: "release-evidence",
      command: NODE,
      args: [
        "scripts/testing/verify-testing-release.mjs",
        "--soundness",
        "target/soundness.json",
      ],
      needs: ["corpus"],
      weight: 1,
    },
  ].map((step) => Object.freeze({ ...step, needs: Object.freeze(step.needs) })),
);

/** The default graph, or the default graph plus everything CI runs elsewhere. */
export function verifySteps(options) {
  if (options.full !== true) return VERIFY_STEPS;
  return Object.freeze([...VERIFY_STEPS, ...FULL_STEPS]);
}

/**
 * The steps in an order where every step follows everything it needs.
 *
 * Fails loudly on an unknown dependency or a cycle: a graph that cannot be
 * ordered is a bug in the declaration, not a run to attempt anyway.
 */
export function topologicalOrder(steps) {
  const byId = indexById(steps);
  const ordered = [];
  const state = new Map();
  for (const step of steps) visit(step, byId, state, ordered);
  return ordered;
}

function visit(step, byId, state, ordered) {
  const mark = state.get(step.id);
  if (mark === "done") return;
  if (mark === "visiting") {
    throw new Error(`Verify graph has a cycle through step "${step.id}".`);
  }
  state.set(step.id, "visiting");
  for (const need of step.needs) {
    visit(requireStep(byId, need, step.id), byId, state, ordered);
  }
  state.set(step.id, "done");
  ordered.push(step);
}

function indexById(steps) {
  const byId = new Map();
  for (const step of steps) {
    if (byId.has(step.id)) {
      throw new Error(`Verify graph declares step "${step.id}" twice.`);
    }
    byId.set(step.id, step);
  }
  return byId;
}

function requireStep(byId, id, dependentId) {
  const step = byId.get(id);
  if (step === undefined) {
    throw new Error(
      `Verify step "${dependentId}" needs "${id}", which is not a declared step.`,
    );
  }
  return step;
}

/** How many steps a step unblocks, directly or through others. */
export function transitiveDependentCount(steps) {
  const counts = new Map(steps.map((step) => [step.id, 0]));
  for (const step of steps) {
    for (const ancestor of ancestorsOf(step, indexById(steps))) {
      counts.set(ancestor, (counts.get(ancestor) ?? 0) + 1);
    }
  }
  return counts;
}

function ancestorsOf(step, byId) {
  const seen = new Set();
  const queue = [...step.needs];
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    queue.push(...requireStep(byId, id, step.id).needs);
  }
  return seen;
}
