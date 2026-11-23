import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { compile } from "tailwindcss";

const resolveExport = `
import { createRequire } from "node:module";
import { join } from "node:path";
const [base, specifier] = process.argv.slice(1);
process.stdout.write(createRequire(join(base, "package.json")).resolve(specifier));
`;

async function loadStylesheet(specifier, base) {
  const path = specifier.startsWith(".")
    ? resolve(base, specifier)
    : execFileSync(
        process.execPath,
        [
          "--conditions=style",
          "--input-type=module",
          "--eval",
          resolveExport,
          base,
          specifier,
        ],
        { encoding: "utf8" },
      );
  return { path, base: dirname(path), content: await readFile(path, "utf8") };
}

test("the public stylesheet compiles with its palette, fonts, and custom utilities", async () => {
  const entry = createRequire(import.meta.url).resolve(
    "@dads-framework/ui/styles/index.css",
  );
  const base = dirname(entry);
  const source = await readFile(entry, "utf8");
  const stylesheet = await compile(source, { base, loadStylesheet });
  const css = stylesheet.build(["readout", "bg-background"]);

  assert.match(css, /\.readout\s*\{[^}]*font-variant-numeric:/);
  assert.match(css, /\.bg-background\s*\{[^}]*background-color:/);
  assert.match(css, /@font-face\s*\{/);
  assert.doesNotMatch(css, /@import\s+["']/);
});
