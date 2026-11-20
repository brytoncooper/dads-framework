import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { relativeSafe, sha256 } from "./testing-soundness-lib.mjs";

export function readSoundnessCorpus(fixture, repositoryRoot) {
  const bytes = readFileSync(join(fixture, "cases.json"));
  const corpus = JSON.parse(bytes.toString("utf8"));
  const context = {
    fixture: relativeSafe(repositoryRoot, fixture),
    casesSha256: sha256(bytes),
  };
  if (corpus.generator === undefined) return { corpus, context };
  const generator = corpus.generator;
  if (
    generator?.schemaVersion !== 1 ||
    !Number.isInteger(generator.seed) ||
    generator.seed < 0 ||
    generator.seed > 0xffffffff ||
    !["fanout", "chain"].includes(generator.topology) ||
    generator.projectCount !== 3 ||
    generator.graphFile !== "graph.json"
  ) {
    throw new Error("Unsupported soundness generator metadata.");
  }
  const graphPath = join(fixture, "graph.json");
  if (!lstatSync(graphPath).isFile()) {
    throw new Error("Soundness graph metadata must be a regular file.");
  }
  const graphBytes = readFileSync(graphPath);
  const graph = JSON.parse(graphBytes.toString("utf8"));
  if (
    graph?.schemaVersion !== 1 ||
    graph.kind !== "dads-testing-soundness-generator-graph" ||
    graph.seed !== generator.seed ||
    graph.topology !== generator.topology ||
    !Array.isArray(graph.projects) ||
    graph.projects.length !== generator.projectCount
  ) {
    throw new Error("Soundness graph does not match its generator metadata.");
  }
  return {
    corpus,
    context: {
      ...context,
      generator,
      graph,
      graphSha256: sha256(graphBytes),
    },
  };
}

export function caseProofContext(testCase) {
  const context = {};
  for (const key of ["proofPath", "mutationKind"]) {
    if (testCase[key] === undefined) continue;
    if (typeof testCase[key] !== "string" || testCase[key].length === 0) {
      throw new Error(`${testCase.id} has invalid ${key} metadata.`);
    }
    context[key] = testCase[key];
  }
  return context;
}
