import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, test } from "vitest";

const workspace = fileURLToPath(new URL("../../..", import.meta.url));
const CJS_RUNTIME_FILES = [
  "packages/core/src/leaf.ts",
  "packages/core/src/reexport.ts",
  "packages/core/src/runtime.cjs",
  "apps/web/src/runtime.cjs",
  "apps/web/src/dynamic.cjs",
];

test("CommonJS consumers preserve their runtime export contracts", () => {
  const emitted = mkdtempSync(join(tmpdir(), "dads-cjs-runtime-"));
  const requireEmitted = createRequire(join(emitted, "package.json"));
  try {
    writeFileSync(join(emitted, "package.json"), '{"type":"commonjs"}\n');
    for (const relPath of CJS_RUNTIME_FILES) {
      emitCommonJsFile(join(workspace, relPath), join(emitted, relPath));
    }

    const runtime = requireEmitted("./apps/web/src/runtime.cjs");
    expect(runtime.leaf).toBe("baseline");
    expect(Object.keys(runtime).sort()).toEqual(["leaf"]);

    const dynamic = requireEmitted("./apps/web/src/dynamic.cjs");
    expect(dynamic.leaf).toBe("baseline");
    expect(dynamic.dynamicMarker).toBe("dynamic-marker");
    expect(Object.keys(dynamic).sort()).toEqual(["dynamicMarker", "leaf"]);
  } finally {
    const emittedPrefix = `${realpathSync(emitted)}${sep}`;
    for (const modulePath of Object.keys(requireEmitted.cache)) {
      if (modulePath.startsWith(emittedPrefix)) delete requireEmitted.cache[modulePath];
    }
    rmSync(emitted, { recursive: true, force: true });
  }
});

function emitCommonJsFile(input, output) {
  mkdirSync(dirname(output), { recursive: true });
  if (input.endsWith(".cjs")) {
    copyFileSync(input, output);
  } else if (input.endsWith(".ts") && !input.endsWith(".d.ts")) {
    const result = transpileModule(readFileSync(input, "utf8"), {
      fileName: input,
      compilerOptions: {
        module: ModuleKind.CommonJS,
        target: ScriptTarget.ES2022,
      },
    });
    writeFileSync(output.replace(/\.ts$/, ".js"), result.outputText);
  }
}
