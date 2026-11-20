import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import process from "node:process";
import test from "node:test";
import { URL, fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const generator = join(
  repository,
  "scripts/testing/generate-testing-soundness.mjs",
);
const fixture = join(repository, "fixtures/testing-soundness");

function filesUnder(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    return entry.isDirectory() ? filesUnder(root, path) : [path];
  });
}

function directoryDigest(root) {
  const hash = createHash("sha256");
  for (const path of filesUnder(root).sort()) {
    hash.update(relative(root, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function runGenerator(seed, output) {
  const result = spawnSync(
    process.execPath,
    [generator, "--seed", String(seed), "--output", output],
    {
      cwd: repository,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return {
    graph: JSON.parse(readFileSync(join(output, "graph.json"), "utf8")),
    manifest: JSON.parse(
      readFileSync(join(output, "dads.testing.json"), "utf8"),
    ),
    cases: JSON.parse(readFileSync(join(output, "cases.json"), "utf8")),
  };
}

function taskIds(projects, kinds = ["lint", "typecheck", "test"]) {
  return projects
    .flatMap((project) => kinds.map((kind) => `${project}:${kind}`))
    .sort();
}

function projectClosure(seed, owner) {
  if (owner === "p2") return ["p2"];
  if (owner === "p1") return seed % 2 === 1 ? ["p1", "p2"] : ["p1"];
  return ["p0", "p1", "p2"];
}

function expectedCases(seed) {
  return ["p0", "p1", "p2"].flatMap((owner) => {
    const closure = projectClosure(seed, owner);
    const valueTests = closure.map((project) => `${project}:test`).sort();
    const controlSelection = taskIds(closure, ["lint", "typecheck"])
      .concat(taskIds([owner], ["test"]))
      .sort();
    return [
      {
        id: `${owner}-value`,
        classification: "breaking",
        changed: valueTests,
        selected: taskIds(closure),
      },
      {
        id: `${owner}-unused-number`,
        classification: "control",
        changed: [],
        selected: controlSelection,
      },
      {
        id: `${owner}-unused-string`,
        classification: "breaking",
        changed: [`${owner}:typecheck`],
        selected: controlSelection,
      },
      {
        id: `${owner}-unused-console`,
        classification: "breaking",
        changed: [`${owner}:lint`],
        selected: taskIds(closure),
      },
    ];
  });
}

function assertGeneratedTools(output, taskMap) {
  const baseline = join(output, "baseline");
  assert.ok(!existsSync(join(baseline, "eslint.config.mjs")));
  assert.deepEqual(
    JSON.parse(readFileSync(join(baseline, ".oxlintrc.json"), "utf8")),
    {
      plugins: ["typescript"],
      categories: { correctness: "error" },
      rules: { "no-console": "error" },
    },
  );
  for (const project of ["p0", "p1", "p2"]) {
    assert.deepEqual(taskMap.get(`${project}:lint`).execution, {
      executable: "node",
      args: ["node_modules/oxlint/bin/oxlint", `packages/${project}/src`],
    });
    assert.deepEqual(taskMap.get(`${project}:typecheck`).execution, {
      executable: "node",
      args: [
        "node_modules/typescript-native/bin/tsc",
        "--project",
        `packages/${project}/tsconfig.json`,
        "--pretty",
        "false",
      ],
    });
  }
}

function assertGeneratedShape(output, seed) {
  const generated = runGenerator(seed, output);
  const topology = seed % 2 === 0 ? "fanout" : "chain";
  assert.deepEqual(generated.cases.generator, {
    schemaVersion: 1,
    seed,
    topology,
    projectCount: 3,
    graphFile: "graph.json",
  });
  assert.equal(generated.graph.schemaVersion, 1);
  assert.equal(generated.graph.kind, "dads-testing-soundness-generator-graph");
  assert.equal(generated.graph.seed, seed);
  assert.equal(generated.graph.topology, topology);
  assert.deepEqual(
    generated.graph.projects.map((project) => ({
      id: project.id,
      root: project.root,
      dependsOn: project.dependsOn,
    })),
    [
      { id: "p0", root: "packages/p0", dependsOn: [] },
      { id: "p1", root: "packages/p1", dependsOn: ["p0"] },
      {
        id: "p2",
        root: "packages/p2",
        dependsOn: topology === "fanout" ? ["p0"] : ["p1"],
      },
    ],
  );
  assert.deepEqual(
    generated.graph.relationships.map((relationship) => ({
      fromProject: relationship.fromProject,
      toProject: relationship.toProject,
      fromModule: relationship.fromModule,
      toModule: relationship.toModule,
    })),
    [
      {
        fromProject: "p0",
        toProject: "p1",
        fromModule: "value",
        toModule: "value",
      },
      {
        fromProject: topology === "fanout" ? "p0" : "p1",
        toProject: "p2",
        fromModule: "value",
        toModule: "value",
      },
    ],
  );
  for (const project of generated.graph.projects) {
    assert.deepEqual(
      project.modules.map((module) => module.id),
      ["value", "unused"],
    );
    assert.ok(
      project.modules.every((module) => typeof module.path === "string"),
    );
    assert.ok(
      project.modules.every(
        (module) => typeof module.baselineValue === "number",
      ),
    );
    assert.ok(Array.isArray(project.taskInputs));
    const inputs = new Map(
      project.taskInputs.map((input) => [input.taskId, input]),
    );
    assert.deepEqual(inputs.get(`${project.id}:lint`).declaredInputs, [
      `${project.root}/src`,
      ".oxlintrc.json",
    ]);
    assert.ok(
      !inputs
        .get(`${project.id}:test`)
        .declaredInputs.includes(`${project.root}/src/unused.ts`),
    );
    if (project.id !== "p0")
      assert.ok(
        inputs
          .get(`${project.id}:test`)
          .declaredInputs.some(
            (path) =>
              path.endsWith("/src/value.ts") && !path.startsWith(project.root),
          ),
      );
  }
  const taskMap = new Map(
    generated.manifest.tasks.map((task) => [task.id, task]),
  );
  assert.deepEqual([...taskMap.keys()].sort(), taskIds(["p0", "p1", "p2"]));
  for (const project of ["p0", "p1", "p2"]) {
    assert.deepEqual(taskMap.get(`${project}:lint`).dependsOn, []);
    assert.deepEqual(taskMap.get(`${project}:typecheck`).dependsOn, [
      `${project}:lint`,
    ]);
    assert.deepEqual(taskMap.get(`${project}:test`).dependsOn, [
      `${project}:typecheck`,
    ]);
  }
  assertGeneratedTools(output, taskMap);
  const actual = new Map(
    generated.cases.cases.map((testCase) => [testCase.id, testCase]),
  );
  assert.equal(actual.size, 12);
  for (const expected of expectedCases(seed)) {
    const testCase = actual.get(expected.id);
    assert.ok(testCase, expected.id);
    assert.equal(testCase.classification, expected.classification);
    assert.deepEqual(
      [...testCase.expectedChangedTaskIds].sort(),
      expected.changed,
    );
    assert.deepEqual(
      [...testCase.expectedSelectionTaskIds].sort(),
      expected.selected,
    );
    assert.deepEqual([...testCase.requiredTaskIds].sort(), expected.selected);
    assert.equal(testCase.operations.length, 1);
    assert.equal(testCase.operations[0].kind, "write");
    assert.match(
      testCase.operations[0].path,
      new RegExp(
        `^packages/${expected.id.slice(0, 2)}/src/(value|unused)\\.ts$`,
      ),
    );
    if (expected.id.endsWith("-value")) {
      assert.match(
        testCase.operations[0].contents,
        /export const value: number/,
      );
      assert.doesNotMatch(testCase.operations[0].contents, /ownValue/);
    }
    assert.equal(typeof testCase.proofPath, "string");
    assert.equal(typeof testCase.mutationKind, "string");
  }
  return generated;
}

test("known seeds encode independent fanout and chain closures", () => {
  const root = mkdtempSync(
    join(process.env.TMPDIR ?? "/tmp", "dads-generator-shape-"),
  );
  try {
    const seed0 = join(root, "seed0");
    const seed1 = join(root, "seed1");
    assertGeneratedShape(seed0, 0);
    assertGeneratedShape(seed1, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generation is byte-reproducible, varies by seed, and leaves the source fixture untouched", () => {
  const root = mkdtempSync(
    join(process.env.TMPDIR ?? "/tmp", "dads-generator-determinism-"),
  );
  const before = directoryDigest(fixture);
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    const other = join(root, "other");
    runGenerator(0, first);
    runGenerator(0, second);
    runGenerator(1, other);
    assert.equal(directoryDigest(first), directoryDigest(second));
    assert.notEqual(directoryDigest(first), directoryDigest(other));
    assert.equal(directoryDigest(fixture), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generator rejects invalid inputs and refuses an existing output directory", () => {
  const root = mkdtempSync(
    join(process.env.TMPDIR ?? "/tmp", "dads-generator-input-"),
  );
  const invoke = (args) =>
    spawnSync(process.execPath, [generator, ...args], {
      cwd: repository,
      encoding: "utf8",
    });
  try {
    const missing = invoke([]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /--seed is required/);
    for (const args of [
      ["--seed", "-1", "--output", join(root, "negative")],
      ["--seed", "4294967296", "--output", join(root, "large")],
      ["--seed", "1.5", "--output", join(root, "fraction")],
    ]) {
      const result = invoke(args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /seed/i);
    }
    const existing = join(root, "existing");
    const marker = join(existing, "marker");
    mkdirSync(existing);
    writeFileSync(marker, "keep");
    const result = invoke(["--seed", "0", "--output", existing]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /output.*exist|exist.*output/i);
    assert.equal(readFileSync(marker, "utf8"), "keep");
    assert.ok(existsSync(marker));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
