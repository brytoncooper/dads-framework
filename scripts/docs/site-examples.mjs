import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const GUIDE_FENCE_LANGUAGES = new Set(["sh", "bash", "json", "http", "text"]);

export function validateGuideCode(page, token) {
  if (page.section !== "Guides" || token.type !== "code") return;
  const language = token.lang?.trim();
  if (!GUIDE_FENCE_LANGUAGES.has(language)) {
    throw new Error(
      `${page.path}: use a source-backed excerpt for executable code, or label the block sh, bash, json, http, or text.`,
    );
  }
  if (language === "json") {
    try {
      JSON.parse(token.text);
    } catch (error) {
      throw new Error(`${page.path}: invalid JSON code block: ${error.message}`, { cause: error });
    }
  }
}

export function loadPageExamples(page, readFile) {
  for (const { source, proof } of page.examples ?? []) {
    if (
      typeof source !== "string" ||
      !/\.tsx?$/u.test(source) ||
      typeof proof !== "string" ||
      !/\.(?:test|spec)\.tsx?$/u.test(proof)
    ) {
      throw new Error(`${page.path}: examples need a TypeScript source and a Vitest proof file.`);
    }
    readFile(source);
    readFile(proof);
  }
}

export function checkExamples(root, pages) {
  const sources = new Set();
  const tests = new Set();
  for (const page of pages) {
    for (const { source, proof } of page.examples ?? []) {
      sources.add(source);
      tests.add(proof);
    }
  }
  if (tests.size === 0) throw new Error("The documentation has no executable examples.");
  const sourcePaths = [...new Set([...sources, ...tests])];
  const tsc = "node_modules/typescript-native/bin/tsc";
  if (!existsSync(join(root, tsc))) throw new Error("Install the workspace before checking docs.");
  const compileArguments = [
    tsc,
    "--ignoreConfig",
    "--noEmit",
    "--strict",
    "--exactOptionalPropertyTypes",
    "--skipLibCheck",
    "--target",
    "es2022",
    "--module",
    "nodenext",
    "--jsx",
    "react-jsx",
    ...sourcePaths,
  ];
  execFileSync(process.execPath, compileArguments, {
    cwd: root,
    stdio: "inherit",
  });
  execFileSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--reporter=dot", ...tests], {
    cwd: root,
    stdio: "inherit",
  });
  return tests.size;
}
