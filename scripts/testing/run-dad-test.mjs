/**
 * Runs the repository's own `dad-test` CLI against the root `dads.testing.json`
 * using the locally built Rust engine (`DADS_TEST_NATIVE_BINARY`,
 * `target/release/dad-test`, or `target/debug/dad-test`).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { resolveLocalDadTestBinary } from "../verify-dad-test.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CLI_ENTRY = join(REPO_ROOT, "packages", "testing", "core", "bin", "dad-test.js");
const BUILT_CLI = join(REPO_ROOT, "packages", "testing", "core", "dist", "cli.js");

function main(argv) {
  const binary = resolveLocalDadTestBinary(REPO_ROOT, process.env);
  if (binary === null) {
    process.stderr.write(
      "test:dad: no local dad-test binary found. Build one with `cargo build -p dad-test` or set DADS_TEST_NATIVE_BINARY.\n",
    );
    return 1;
  }
  if (!existsSync(BUILT_CLI)) {
    process.stderr.write(
      "test:dad: @dads-framework/testing is not built. Run `npm run build --workspace @dads-framework/testing` first.\n",
    );
    return 1;
  }
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...argv], {
    cwd: REPO_ROOT,
    env: { ...process.env, DADS_TEST_NATIVE_BINARY: binary },
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

process.exitCode = main(process.argv.slice(2));
