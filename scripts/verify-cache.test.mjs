import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { afterEach, describe, it } from "node:test";
import {
  RUN_VARIABLE,
  cacheDecision,
  cacheKey,
  finishRunCache,
  hasPassed,
  openRunCache,
  openStepCache,
  openVerifyCache,
  readRecord,
  runThroughCache,
  writeRecord,
} from "./verify-cache.mjs";
import {
  cleanHeadCommit,
  dadTestClosureKey,
  ignoredInputsHash,
  narrowPackagesWithDadTestPlan,
  resolveLocalDadTestBinary,
  runtimeEnvironmentKey,
} from "./verify-dad-test.mjs";
import { gitEnvironment } from "./verify-fingerprint.mjs";
import { summaryBlock } from "./verify-report.mjs";

/** `git` for a fixture, never the repository whose hook is running us. */
function git(root, args) {
  spawnSync("git", args, { cwd: root, env: gitEnvironment() });
}

const COMMAND = ["node", "tool.js", "--check"];
const roots = [];

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function manifest(name, dependencies = {}) {
  return `${JSON.stringify({ name, dependencies })}\n`;
}

/** A workspace: `b` depends on `a`, `c` stands alone. No commit, no identity. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "dads-verify-cache-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  write(root, ".gitignore", "node_modules/\ndist/\n.dads/\nprivate/\n");
  write(root, "package.json", JSON.stringify({ workspaces: ["packages/*"] }));
  write(root, "package-lock.json", "{}\n");
  write(root, "tsconfig.base.json", "{}\n");
  write(root, "packages/a/package.json", manifest("a"));
  write(root, "packages/a/src/index.ts", "export const a = 1;\n");
  write(root, "packages/b/package.json", manifest("b", { a: "*" }));
  write(root, "packages/b/src/index.ts", "export const b = 2;\n");
  write(root, "packages/c/package.json", manifest("c"));
  write(root, "packages/c/src/index.ts", "export const c = 3;\n");
  return root;
}

function contextFor(root) {
  const context = openRunCache(root, {});
  assert.equal(context.error, undefined);
  return context;
}

function packageKey(root, directory = "packages/b", command = COMMAND) {
  return cacheKey(contextFor(root), { kind: "package", directory }, command);
}

function treeKey(root) {
  return cacheKey(contextFor(root), { kind: "tree" }, COMMAND);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("a package-scoped key", () => {
  it("is stable while nothing changes", () => {
    const root = workspace();
    assert.equal(packageKey(root), packageKey(root));
  });

  it("changes with the package's own files, uncommitted and untracked", () => {
    const root = workspace();
    const before = packageKey(root);
    write(root, "packages/b/src/new.ts", "export const fresh = true;\n");
    assert.notEqual(packageKey(root), before);
  });

  it("changes with a workspace dependency", () => {
    const root = workspace();
    const before = packageKey(root);
    write(root, "packages/a/src/index.ts", "export const a = 10;\n");
    assert.notEqual(packageKey(root), before);
  });

  it("changes with a workspace package imported but never declared", () => {
    const root = workspace();
    write(root, "packages/b/src/use.ts", 'import { c } from "c";\nexport { c };\n');
    const before = packageKey(root);
    write(root, "packages/c/src/index.ts", "export const c = 30;\n");
    assert.notEqual(packageKey(root), before);
  });

  it("changes with a dependency reached only through tsconfig references", () => {
    const root = workspace();
    write(root, "packages/b/tsconfig.json", JSON.stringify({ references: [{ path: "../c" }] }));
    const before = packageKey(root);
    write(root, "packages/c/src/index.ts", "export const c = 30;\n");
    assert.notEqual(packageKey(root), before);
  });

  it("changes with the lockfile", () => {
    const root = workspace();
    const before = packageKey(root);
    write(root, "package-lock.json", '{"lockfileVersion":3}\n');
    assert.notEqual(packageKey(root), before);
  });

  it("changes with a root config", () => {
    const root = workspace();
    const before = packageKey(root);
    write(root, "tsconfig.base.json", '{"compilerOptions":{"strict":true}}\n');
    assert.notEqual(packageKey(root), before);
  });

  it("changes with the step's command", () => {
    const root = workspace();
    assert.notEqual(packageKey(root, "packages/b", ["node", "tool.js", "--fix"]), packageKey(root));
  });

  it("does not change with a package it does not reach", () => {
    const root = workspace();
    const before = packageKey(root);
    write(root, "packages/c/src/index.ts", "export const c = 300;\n");
    assert.equal(packageKey(root), before);
  });

  it("widens to the whole tree when the package names a path outside itself", () => {
    const root = workspace();
    write(root, "packages/b/src/read.ts", 'export const docs = "../../../docs/guide.md";\n');
    const before = packageKey(root);
    write(root, "packages/c/src/index.ts", "export const c = 300;\n");
    assert.notEqual(packageKey(root), before);
  });

  it("is unknown for a directory that is not a workspace package", () => {
    const root = workspace();
    const before = packageKey(root, "packages/missing");
    write(root, "packages/c/src/index.ts", "export const c = 300;\n");
    assert.notEqual(packageKey(root, "packages/missing"), before);
  });

  it("ignores root Rust metadata and JSDoc package mentions without widening", () => {
    const root = workspace();
    write(
      root,
      "packages/b/src/docs.ts",
      "/** Mentions `c` and takes workspaceRoot. */\nexport const format = (workspaceRoot: string) => workspaceRoot;\n",
    );
    const before = packageKey(root);
    write(root, "Cargo.lock", "version = 4\n");
    write(root, "packages/c/src/index.ts", "export const c = 999;\n");
    assert.equal(packageKey(root), before);
  });

  it("does not widen staticOnly typecheck scopes on runtime process.cwd() calls", () => {
    const root = workspace();
    write(root, "packages/b/src/cwd.ts", "export const where = () => process.cwd();\n");
    const staticKey = () =>
      cacheKey(contextFor(root), { kind: "package", directory: "packages/b", staticOnly: true }, COMMAND);
    const beforeStatic = staticKey();
    const beforeRuntime = packageKey(root);
    write(root, "packages/c/src/index.ts", "export const c = 42;\n");
    assert.equal(staticKey(), beforeStatic);
    assert.notEqual(packageKey(root), beforeRuntime);
  });
});

describe("dad-test local verify integration", () => {
  it("resolves DADS_TEST_NATIVE_BINARY, then target/release, then target/debug", () => {
    const root = workspace();
    assert.equal(resolveLocalDadTestBinary(root, {}), null);
    const exe = process.platform === "win32" ? "dad-test.exe" : "dad-test";
    write(root, `target/debug/${exe}`, "debug");
    assert.equal(resolveLocalDadTestBinary(root, {}), join(root, "target", "debug", exe));
    write(root, `target/release/${exe}`, "release");
    assert.equal(resolveLocalDadTestBinary(root, {}), join(root, "target", "release", exe));
    write(root, "custom-dad-test", "custom");
    assert.equal(
      resolveLocalDadTestBinary(root, { DADS_TEST_NATIVE_BINARY: "custom-dad-test" }),
      join(root, "custom-dad-test"),
    );
  });

  it("keys dad-test closures by project roots and impact globs while ignoring unrelated files", () => {
    const root = workspace();
    const closure = {
      projectRoots: ["packages/a", "packages/b"],
      impactPaths: ["formal/spec/**"],
      extraFiles: [],
    };
    write(root, "formal/spec/proof.lean", "theorem t : True := trivial\n");
    const keyNow = () => dadTestClosureKey(contextFor(root), closure, COMMAND);
    const before = keyNow();

    write(root, "third-party/dad-test/Cargo.lock.sha256", "abc123\n");
    write(root, "Cargo.lock", "lock = 1\n");
    write(root, "packages/c/src/index.ts", "export const c = 500;\n");
    assert.equal(keyNow(), before);

    write(root, "formal/spec/proof.lean", "theorem t : True := by trivial\n");
    assert.notEqual(keyNow(), before);
  });

  it("narrows remaining packages via dad-test plan only when proven unaffected from a clean commit", () => {
    const root = workspace();
    write(
      root,
      "dads.testing.json",
      JSON.stringify({
        schemaVersion: 1,
        workspace: { root: ".", fullFallback: { taskIds: ["b:test", "c:test"] } },
        projects: [
          { id: "b", root: "packages/b", fallbackDependencies: [] },
          { id: "c", root: "packages/c", fallbackDependencies: [] },
        ],
        tasks: [],
      }),
    );
    git(root, ["config", "user.name", "Fixture"]);
    git(root, ["config", "user.email", "fixture@dads.invalid"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "baseline"]);

    const fakeBinary = join(root, "fake-dad-test.cjs");
    write(
      root,
      "fake-dad-test.cjs",
      `#!${process.execPath}
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const req = JSON.parse(raw);
  const fullFallback = process.env.FAKE_FALLBACK === "1";
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    ok: true,
    result: {
      operation: "plan",
      plan: {
        complete: true,
        scope: { kind: "base-to-working-tree", base: req.base, fullFallback, changedPaths: [] },
        tasks: [
          { id: "b:test", project: "b", decision: "skip-proven-unaffected" },
          { id: "c:test", project: "c", decision: "run" }
        ]
      }
    }
  }));
});
`,
    );
    chmodSync(fakeBinary, 0o755);

    const cleanContext = contextFor(root);
    const cleanCommit = cleanHeadCommit(root, cleanContext.fingerprint);
    assert.ok(cleanCommit === null, "untracked fake binary makes working tree dirty");

    git(root, ["add", "fake-dad-test.cjs"]);
    git(root, ["commit", "-qm", "add fake binary"]);
    const committedContext = contextFor(root);
    const commitSha = cleanHeadCommit(root, committedContext.fingerprint);
    assert.ok(typeof commitSha === "string" && commitSha.length >= 40);

    const runtimeKey = runtimeEnvironmentKey(committedContext, COMMAND);
    const ignoredHash = ignoredInputsHash(committedContext.fingerprint);
    for (const dir of ["packages/b", "packages/c"]) {
      writeRecord(committedContext, "test", dir, {
        key: "old-key",
        cleanCommit: commitSha,
        runtimeKey,
        ignoredHash,
        suites: [{ name: `${dir}/index.test.ts`, status: "passed" }],
      });
    }

    const toRun = [
      { directory: "packages/b", key: "new-key" },
      { directory: "packages/c", key: "new-key" },
    ];
    const narrowed = narrowPackagesWithDadTestPlan({
      root,
      env: { DADS_TEST_NATIVE_BINARY: fakeBinary },
      cache: committedContext,
      toRun,
      taskKind: "test",
      command: COMMAND,
      readRecord,
      recordKind: "test",
    });
    assert.deepEqual(
      narrowed.provenUnaffected.map((item) => item.directory),
      ["packages/b"],
    );
    assert.deepEqual(
      narrowed.remaining.map((item) => item.directory),
      ["packages/c"],
    );

    // Fails closed when dad-test reports fullFallback.
    const previousFallback = process.env.FAKE_FALLBACK;
    process.env.FAKE_FALLBACK = "1";
    try {
      const closed = narrowPackagesWithDadTestPlan({
        root,
        env: { DADS_TEST_NATIVE_BINARY: fakeBinary },
        cache: committedContext,
        toRun,
        taskKind: "test",
        command: COMMAND,
        readRecord,
        recordKind: "test",
      });
      assert.equal(closed.provenUnaffected.length, 0);
      assert.equal(closed.remaining.length, 2);
    } finally {
      if (previousFallback === undefined) delete process.env.FAKE_FALLBACK;
      else process.env.FAKE_FALLBACK = previousFallback;
    }
  });
});

describe("a tree-scoped key", () => {
  it("changes with any file, and with a gitignored input", () => {
    const root = workspace();
    const before = treeKey(root);
    write(root, "private/patterns.json", "[]\n");
    const withIgnored = treeKey(root);
    assert.notEqual(withIgnored, before);
    write(root, "private/patterns.json", '["secret"]\n');
    assert.notEqual(treeKey(root), withIgnored);
  });

  it("ignores build output the build step derives from the tree", () => {
    const root = workspace();
    const before = treeKey(root);
    write(root, "packages/a/dist/index.js", "export const a = 1;\n");
    assert.equal(treeKey(root), before);
  });

  it("changes when a file is staged, because ls-files readers see it then", () => {
    const root = workspace();
    const before = treeKey(root);
    git(root, ["add", "packages/a/src/index.ts"]);
    assert.notEqual(treeKey(root), before);
  });

  it("is null outside a repository", () => {
    const root = mkdtempSync(join(tmpdir(), "dads-verify-no-git-"));
    roots.push(root);
    assert.notEqual(openRunCache(root, {}).error, undefined);
  });
});

describe("when the cache is used at all", () => {
  it("is off with CI set, with --no-cache, and with --full", () => {
    assert.equal(cacheDecision({}, { CI: "true" }).enabled, false);
    assert.equal(cacheDecision({ noCache: true }, {}).enabled, false);
    assert.equal(cacheDecision({ full: true }, {}).enabled, false);
    assert.equal(cacheDecision({}, { CI: "" }).enabled, true);
  });

  it("opens nothing, and writes nothing, for a run under CI", () => {
    const root = workspace();
    const environment = { CI: "true", [RUN_VARIABLE]: "/elsewhere/run.json" };
    const { cache, state } = openVerifyCache({}, root, environment);
    assert.equal(cache, null);
    assert.equal(state.reason, "CI is set");
    assert.equal(environment[RUN_VARIABLE], undefined);
    assert.equal(existsSync(join(root, ".dads")), false);
  });

  it("never reads a record under CI, even a matching one", async () => {
    const root = workspace();
    const run = contextFor(root);
    const step = {
      id: "lint",
      command: "node",
      args: ["lint.js"],
      cache: { kind: "tree" },
    };
    const key = cacheKey(run, step.cache, [step.command, ...step.args]);
    writeRecord(run, "steps", step.id, { key });
    write(root, ".dads/verify-cache/steps/broken.json", "{ not json");

    const local = openStepCache(root, { [RUN_VARIABLE]: run.runFile });
    assert.equal(hasPassed(local, "steps", step.id, key), true);
    assert.equal(hasPassed(local, "steps", "broken", key), false);

    const ci = openStepCache(root, { CI: "1", [RUN_VARIABLE]: run.runFile });
    assert.equal(ci, null);
    let ran = 0;
    const outcome = await runThroughCache(ci, step, () => {
      ran += 1;
      return Promise.resolve({ exitCode: 0, output: "" });
    });
    assert.equal(ran, 1);
    assert.equal(outcome.cache, undefined);
  });
});

describe("a verify run through the cache", () => {
  function lintStep() {
    return {
      id: "lint",
      command: "node",
      args: ["lint.js"],
      cache: { kind: "tree" },
    };
  }

  function passing() {
    let calls = 0;
    const run = () => {
      calls += 1;
      return Promise.resolve({ exitCode: 0, output: "" });
    };
    return { run, calls: () => calls };
  }

  it("skips a step that passed on the same inputs, and reruns it after a change", async () => {
    const root = workspace();
    const step = lintStep();
    const counter = passing();

    const first = contextFor(root);
    await runThroughCache(first, step, counter.run);
    assert.equal(finishRunCache(first), "");

    const second = contextFor(root);
    assert.equal((await runThroughCache(second, step, counter.run)).cache, "hit");
    finishRunCache(second);
    assert.equal(counter.calls(), 1);

    write(root, "packages/c/src/index.ts", "export const c = 4;\n");
    const third = contextFor(root);
    await runThroughCache(third, step, counter.run);
    assert.equal(counter.calls(), 2);
  });

  it("records nothing when a step fails", async () => {
    const root = workspace();
    const step = lintStep();
    const first = contextFor(root);
    await runThroughCache(first, step, () => Promise.resolve({ exitCode: 1, output: "" }));
    finishRunCache(first);
    const second = contextFor(root);
    const key = cacheKey(second, step.cache, [step.command, ...step.args]);
    assert.equal(hasPassed(second, "steps", step.id, key), false);
  });

  it("drops the run's records when the checkout moved while it ran", async () => {
    const root = workspace();
    const step = lintStep();
    const run = contextFor(root);
    const key = cacheKey(run, { kind: "package", directory: "packages/a" }, COMMAND);
    writeRecord(run, "test", "packages/a", { key });
    await runThroughCache(run, step, passing().run);
    write(root, "packages/a/src/index.ts", "export const a = 99;\n");
    assert.match(finishRunCache(run), /changed while verify ran/u);
    const after = contextFor(root);
    assert.equal(hasPassed(after, "test", "packages/a", key), false);
    const stepKey = cacheKey(run, step.cache, [step.command, ...step.args]);
    assert.equal(hasPassed(after, "steps", step.id, stepKey), false);
  });
});

describe("the summary", () => {
  it("names the cached steps and the partly cached ones", () => {
    const result = (id, cache) => ({
      step: { id, needs: [] },
      status: "passed",
      exitCode: 0,
      output: "",
      durationMs: 0,
      cache,
    });
    const text = summaryBlock({
      results: [result("format", "hit"), result("test", "3 of 5 packages cached"), result("build", null)],
      wallMs: 1,
      receipt: "budget 1",
      budget: { jobs: 1 },
      cacheState: { enabled: true, reason: "", note: "" },
    });
    assert.match(text, /format\s+0\.00s {2}cached/u);
    assert.match(text, /cached 1 of 3 steps: format/u);
    assert.match(text, /partly cached: test \(3 of 5 packages cached\)/u);
  });

  it("says why there was no cache", () => {
    const text = summaryBlock({
      results: [],
      wallMs: 1,
      receipt: "budget 1",
      budget: { jobs: 1 },
      cacheState: { enabled: false, reason: "CI is set", note: "" },
    });
    assert.match(text, /cache off: CI is set/u);
  });
});

it("reruns the history-sensitive ratchet when the commit or resolved base moves without file changes", async () => {
  const root = workspace();
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@dads.invalid"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "First history"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  const step = {
    id: "source-budgets",
    command: "node",
    args: ["check-source-budgets.mjs"],
    cache: { kind: "tree", history: true },
  };
  let checks = 0;
  const pass = async () => {
    checks += 1;
    return { exitCode: 0, output: "" };
  };
  const verify = async () => {
    const run = contextFor(root);
    const result = await runThroughCache(run, step, pass);
    finishRunCache(run);
    return result;
  };

  assert.equal((await verify()).cache, null);
  assert.equal((await verify()).cache, "hit");
  const tree = treeKey(root);

  git(root, ["commit", "--allow-empty", "-qm", "Different history"]);
  assert.equal(treeKey(root), tree);
  assert.equal((await verify()).cache, null);
  assert.equal((await verify()).cache, "hit");

  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  assert.equal(treeKey(root), tree);
  assert.equal((await verify()).cache, null);
  assert.equal((await verify()).cache, "hit");
  assert.equal(checks, 3);
});
