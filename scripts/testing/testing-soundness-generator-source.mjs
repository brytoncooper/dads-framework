import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function write(root, path, contents) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

export function writeBaseline(root, model) {
  write(
    root,
    "package.json",
    `${JSON.stringify({ name: "dads-generated-testing-soundness", private: true, type: "module" }, null, 2)}\n`,
  );
  write(
    root,
    ".oxlintrc.json",
    `${JSON.stringify(
      {
        plugins: ["typescript"],
        categories: { correctness: "error" },
        rules: { "no-console": "error" },
      },
      null,
      2,
    )}\n`,
  );
  write(root, ".gitignore", "/node_modules\n/.dads\n/.vitest\n/.vite\n");
  write(
    root,
    "vitest.config.mjs",
    `import { defineConfig } from "vitest/config";\n\nexport default defineConfig({\n  cacheDir: ".vitest",\n  test: { cache: false, include: ["packages/*/src/**/*.test.ts"] },\n});\n`,
  );
  for (const project of model.projects) {
    const upstream = project.dependsOn[0];
    const importLine =
      upstream === undefined
        ? ""
        : `import { value as upstreamValue } from "../../${upstream}/src/value.js";\n`;
    write(
      root,
      `${project.root}/src/value.ts`,
      `${importLine}export const value: number = ${upstream === undefined ? project.ownIncrement : `upstreamValue + ${project.ownIncrement}`};\n`,
    );
    write(
      root,
      `${project.root}/src/unused.ts`,
      `export const unused: number = ${project.unusedValue};\n`,
    );
    write(
      root,
      `${project.root}/src/value.test.ts`,
      `import { expect, test } from "vitest";\nimport { value } from "./value.js";\n\ntest("${project.id} value follows the generated model", () => {\n  expect(value).toBe(${project.value});\n});\n`,
    );
    write(
      root,
      `${project.root}/tsconfig.json`,
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      )}\n`,
    );
  }
}

export function mutationSource(model, projectId, kind) {
  const project = model.projects.find(
    (candidate) => candidate.id === projectId,
  );
  if (project === undefined)
    throw new Error(`Unknown generated project ${projectId}.`);
  const upstream = project.dependsOn[0];
  const importLine =
    upstream === undefined
      ? ""
      : `import { value as upstreamValue } from "../../${upstream}/src/value.js";\n`;
  if (kind === "value-export") {
    return `${importLine}export const value: number = ${upstream === undefined ? project.ownIncrement + 1 : `upstreamValue + ${project.ownIncrement + 1}`};\n`;
  }
  if (kind === "unused-number")
    return `export const unused: number = ${project.unusedValue + 1};\n`;
  if (kind === "unused-string")
    return `export const unused: number = "invalid";\n`;
  if (kind === "unused-console")
    return `export const unused: number = ${project.unusedValue};\nconsole.log("generated mutation");\n`;
  throw new Error(`Unknown generated mutation kind ${kind}.`);
}
