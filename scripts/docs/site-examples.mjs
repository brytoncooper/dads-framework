import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

export function checkExamples(root, pages, files) {
  const sources = new Set();
  const tests = new Set();
  for (const page of pages) {
    if (
      page.section === "Guides" &&
      /^\s{0,3}(?:```|~~~)/m.test(page.markdown)
    ) {
      throw new Error(
        `${page.path}: link to the runnable sample and its proof instead of duplicating code.`,
      );
    }
    for (const { source, proof } of page.examples ?? []) {
      if (!files.has(`source/${source}`) || !files.has(`source/${proof}`)) {
        throw new Error(
          `${page.path}: link the example and proof in the guide.`,
        );
      }
      sources.add(source);
      tests.add(proof);
    }
  }
  if (tests.size === 0)
    throw new Error("The documentation has no executable examples.");
  const sourcePaths = [...new Set([...sources, ...tests])];
  const tsc = "node_modules/typescript-native/bin/tsc";
  if (!existsSync(join(root, tsc)))
    throw new Error("Install the workspace before checking docs.");
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
  execFileSync(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "--reporter=dot", ...tests],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  return tests.size;
}
