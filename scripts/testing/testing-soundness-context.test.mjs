import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import process from "node:process";
import test from "node:test";
import { readSoundnessCorpus } from "./testing-soundness-context.mjs";
import { createFixture, runFixture } from "./testing-soundness-test-fixture.mjs";

test("custom fixture evidence retains its captured generator model and proof paths", () => {
  const fixture = createFixture();
  try {
    const casesPath = join(fixture.root, "cases.json");
    const corpus = JSON.parse(readFileSync(casesPath, "utf8"));
    corpus.generator = {
      schemaVersion: 1,
      seed: 0,
      topology: "fanout",
      projectCount: 3,
      graphFile: "graph.json",
    };
    for (const testCase of corpus.cases) {
      testCase.proofPath = "independent-test-control";
      testCase.mutationKind = "value";
    }
    writeFileSync(casesPath, JSON.stringify(corpus));
    const graph = {
      schemaVersion: 1,
      kind: "dads-testing-soundness-generator-graph",
      seed: 0,
      topology: "fanout",
      projects: [{ id: "p0" }, { id: "p1" }, { id: "p2" }],
      note: "Metadata transport fixture; task observations use a test double.",
    };
    const graphBytes = JSON.stringify(graph);
    writeFileSync(join(fixture.root, "graph.json"), graphBytes);
    const { result, evidence } = runFixture(fixture, false, { caseJobs: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(evidence.corpus.fixture, relative(process.cwd(), fixture.root).split(sep).join("/"));
    assert.deepEqual(evidence.corpus.generator, corpus.generator);
    assert.deepEqual(evidence.corpus.graph, graph);
    assert.equal(evidence.corpus.graphSha256, createHash("sha256").update(graphBytes).digest("hex"));
    assert.equal(evidence.corpus.casesSha256, createHash("sha256").update(readFileSync(casesPath)).digest("hex"));
    for (const testCase of evidence.cases) {
      assert.equal(testCase.proofPath, "independent-test-control");
      assert.equal(testCase.mutationKind, "value");
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("generator provenance cannot read outside the fixture or accept a mismatched seed", () => {
  const fixture = createFixture();
  try {
    const casesPath = join(fixture.root, "cases.json");
    const corpus = JSON.parse(readFileSync(casesPath, "utf8"));
    corpus.generator = {
      schemaVersion: 1,
      seed: 0,
      topology: "fanout",
      projectCount: 3,
      graphFile: "../graph.json",
    };
    writeFileSync(casesPath, JSON.stringify(corpus));
    assert.throws(() => readSoundnessCorpus(fixture.root, process.cwd()), /Unsupported soundness generator metadata/);
    corpus.generator.graphFile = "graph.json";
    writeFileSync(casesPath, JSON.stringify(corpus));
    writeFileSync(
      join(fixture.root, "graph.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "dads-testing-soundness-generator-graph",
        seed: 1,
        topology: "fanout",
        projects: [{ id: "p0" }, { id: "p1" }, { id: "p2" }],
      }),
    );
    assert.throws(() => readSoundnessCorpus(fixture.root, process.cwd()), /Soundness graph does not match/);
    rmSync(join(fixture.root, "graph.json"));
    symlinkSync(casesPath, join(fixture.root, "graph.json"));
    assert.throws(() => readSoundnessCorpus(fixture.root, process.cwd()), /graph metadata must be a regular file/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
