import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const projectRoot = resolve(".");
const failureMarker = resolve(projectRoot, "verification/fail-provider");
if (existsSync(failureMarker)) process.exit(9);

const typescriptBin = process.env["DADS_TYPESCRIPT_BIN"];
if (!typescriptBin) {
  process.stderr.write("DADS_TYPESCRIPT_BIN is required for fixture compilation.\n");
  process.exit(2);
}

rmSync(resolve(projectRoot, "dist"), { force: true, recursive: true });
const completed = spawnSync(
  process.execPath,
  [typescriptBin, "-p", "verification/tsconfig.policy.json", "--pretty", "false"],
  {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: "pipe",
  },
);
if (completed.status !== 0 || completed.error) {
  process.stderr.write(`${completed.stderr ?? ""}${completed.stdout ?? ""}`);
  process.exit(completed.status ?? 2);
}

rewriteCompiledModules();

function rewriteCompiledModules() {
  const sourceRoot = resolve(projectRoot, "verification/compiled-ts");
  const targetRoot = resolve(projectRoot, "verification/compiled");
  rmSync(targetRoot, { force: true, recursive: true });
  mkdirSync(targetRoot, { recursive: true });
  for (const file of readdirSync(sourceRoot).filter((name) => name.endsWith(".js"))) {
    const source = readFileSync(resolve(sourceRoot, file), "utf8");
    const rewritten = source
      .replaceAll(
        'import { parseZed } from "@dads-framework/access"',
        'import { parseZed } from "../vendor/access/core/parse-zed.js"',
      )
      .replaceAll(
        'import { emitZedForDefinitions } from "@dads-framework/access"',
        'import { emitZedForDefinitions } from "../vendor/access/core/emit-zed.js"',
      );
    writeFileSync(resolve(targetRoot, file), rewritten.replace(/^\/\/# sourceMappingURL=.*$/gm, ""));
  }
}
