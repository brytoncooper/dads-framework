// Copies the non-TypeScript files a package's source imports (stylesheets,
// images, declaration augmentations) from `src/` to `dist/`, keeping their relative paths, so the
// emitted JavaScript finds them. `tsc` emits only JavaScript and declarations.
//
// Usage: node scripts/build/copy-source-assets.mjs [packageDirectory...]
// With no arguments it copies for the package in the working directory.
import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";

const ASSET = /\.(?:css|svg|png|d\.ts)$/;

function copyAssets(sourceRoot, outputRoot, directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      copyAssets(sourceRoot, outputRoot, path);
      continue;
    }
    if (!ASSET.test(entry)) continue;
    const target = join(outputRoot, relative(sourceRoot, path));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(path, target);
  }
}

const packageDirectories = process.argv.length > 2 ? process.argv.slice(2) : ["."];
for (const directory of packageDirectories) {
  const packageRoot = resolve(directory);
  const sourceRoot = join(packageRoot, "src");
  copyAssets(sourceRoot, join(packageRoot, "dist"), sourceRoot);
}
