#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildCases, buildGraph, buildManifest } from "./testing-soundness-generator-cases.mjs";
import { assertDecimalSeed, makeModel } from "./testing-soundness-generator-model.mjs";
import { writeBaseline } from "./testing-soundness-generator-source.mjs";

export function parseGeneratorArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== "--seed" && option !== "--output") throw new Error(`Unsupported option ${option}.`);
    if (values.has(option)) throw new Error(`Duplicate option ${option}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value.`);
    values.set(option, value);
    index += 1;
  }
  if (!values.has("--seed")) throw new Error("--seed is required.");
  if (!values.has("--output")) throw new Error("--output is required.");
  return {
    seed: assertDecimalSeed(values.get("--seed")),
    output: resolve(values.get("--output")),
  };
}

export function generateTestingSoundness({ seed, output }) {
  const model = makeModel(seed);
  mkdirSync(dirname(output), { recursive: true });
  if (existsSync(output)) throw new Error(`Output directory already exists: ${output}.`);
  try {
    mkdirSync(output);
  } catch (error) {
    if (error?.code === "EEXIST")
      throw new Error(`Output directory already exists: ${output}.`, {
        cause: error,
      });
    throw error;
  }
  writeBaseline(resolve(output, "baseline"), model);
  writeJson(resolve(output, "dads.testing.json"), buildManifest(model));
  writeJson(resolve(output, "cases.json"), buildCases(model));
  writeJson(resolve(output, "graph.json"), buildGraph(model));
  return {
    output,
    seed,
    topology: model.topology,
    projectCount: 3,
    caseCount: 12,
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = generateTestingSoundness(parseGeneratorArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
