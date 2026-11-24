#!/usr/bin/env node
/**
 * Fetches only the platform-matching `@dads-framework/testing-native-*` binary
 * directly from npm (no `node_modules` install required) for lightweight CI
 * planning jobs.
 *
 * Usage:
 *   node scripts/testing/fetch-native-binary.mjs --version 0.7.0 --out /tmp/dad-test
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const platformPackages = {
  "darwin/arm64": { pkg: "@dads-framework/testing-native-darwin-arm64", bin: "bin/dad-test" },
  "darwin/x64": { pkg: "@dads-framework/testing-native-darwin-x64", bin: "bin/dad-test" },
  "linux/arm64": { pkg: "@dads-framework/testing-native-linux-arm64-gnu", bin: "bin/dad-test" },
  "linux/x64": { pkg: "@dads-framework/testing-native-linux-x64-gnu", bin: "bin/dad-test" },
  "win32/x64": { pkg: "@dads-framework/testing-native-win32-x64", bin: "bin/dad-test.exe" },
};

function parseArgs(argv) {
  let version = "latest";
  let out = resolve(process.cwd(), process.platform === "win32" ? "dad-test.exe" : "dad-test");
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--version" && argv[i + 1]) {
      version = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--out" && argv[i + 1]) {
      out = resolve(argv[i + 1]);
      i += 1;
    }
  }
  return { version, out };
}

function main() {
  const { version, out } = parseArgs(process.argv.slice(2));
  const key = `${process.platform}/${process.arch}`;
  const entry = platformPackages[key];
  if (!entry) {
    throw new Error(`Unsupported platform/arch for native binary download: ${key}`);
  }
  const spec = `${entry.pkg}@${version}`;
  const scratch = mkdtempSync(join(tmpdir(), "dad-test-fetch-"));
  try {
    const tarballName = execFileSync("npm", ["pack", spec, "--silent"], {
      cwd: scratch,
      encoding: "utf8",
    })
      .trim()
      .split(/\r?\n/)
      .at(-1);
    if (!tarballName) {
      throw new Error(`npm pack ${spec} produced no tarball name.`);
    }
    execFileSync("tar", ["-xzf", tarballName], { cwd: scratch });
    const extractedBinary = join(scratch, "package", entry.bin);
    if (!existsSync(extractedBinary)) {
      throw new Error(`Expected binary at ${extractedBinary} inside ${spec}.`);
    }
    copyFileSync(extractedBinary, out);
    if (process.platform !== "win32") chmodSync(out, 0o755);
    process.stdout.write(`${out}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
