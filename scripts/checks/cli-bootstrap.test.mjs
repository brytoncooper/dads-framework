import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { URL } from "node:url";

const realBin = new URL("../../packages/foundation/toolbox/bin/", import.meta.url);

function fixture(t, packagePath) {
  const root = mkdtempSync(join(tmpdir(), "dad-cli-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const toolbox = join(root, packagePath);
  const bin = join(toolbox, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(toolbox, "package.json"), '{"type":"module"}\n');
  for (const file of ["dad.js", "usage.js"]) {
    copyFileSync(new URL(file, realBin), join(bin, file));
  }
  const env = { ...process.env };
  delete env.GIT_INDEX_FILE;
  delete env.npm_lifecycle_event;
  return {
    root,
    toolbox,
    run(args, extraEnv) {
      return spawnSync(process.execPath, [join(bin, "dad.js"), ...args], {
        cwd: root,
        encoding: "utf8",
        env: { ...env, ...extraEnv },
      });
    },
  };
}

function addSourceCompiler(root, toolbox) {
  writeFileSync(join(root, "dads.project.json"), "{}\n");
  mkdirSync(join(toolbox, "src"));
  writeFileSync(join(toolbox, "src/cli.ts"), "");
  const compiler = join(root, "node_modules/typescript-native/bin");
  mkdirSync(compiler, { recursive: true });
  writeFileSync(
    join(compiler, "tsc"),
    `const fs = require("node:fs");
fs.appendFileSync("build.log", "build\\n");
fs.mkdirSync("packages/foundation/toolbox/dist", { recursive: true });
fs.writeFileSync("packages/foundation/toolbox/dist/cli.js", 'process.stdout.write("ready\\\\n");');
`,
  );
}

test("help in a source checkout requires no build; orient builds once", (t) => {
  const { root, toolbox, run } = fixture(t, "packages/foundation/toolbox");
  addSourceCompiler(root, toolbox);
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: dad/);
  assert.equal(existsSync(join(root, "build.log")), false);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const orient = run(["orient", "src/cli.ts"]);
    assert.equal(orient.status, 0, orient.stderr);
    assert.equal(orient.stdout, "ready\n");
  }
  assert.equal(readFileSync(join(root, "build.log"), "utf8"), "build\n");
});

test("source CLI does no build in install scripts or Git commit hooks", (t) => {
  const { root, toolbox, run } = fixture(t, "packages/foundation/toolbox");
  addSourceCompiler(root, toolbox);
  for (const env of [{ npm_lifecycle_event: "prepare" }, { GIT_INDEX_FILE: join(root, "commit.index") }]) {
    const orient = run(["orient", "src/cli.ts", "--json"], env);
    assert.equal(orient.status, 1);
    assert.match(JSON.parse(orient.stderr).error, /npm run build:cli/);
  }
  assert.equal(existsSync(join(root, "build.log")), false);
});

test("a broken installed toolbox asks for reinstall without trying a compiler", (t) => {
  const { run } = fixture(t, "node_modules/@dads-framework/toolbox");
  const orient = run(["orient", "src/cli.ts", "--json"]);
  assert.equal(orient.status, 1);
  assert.match(JSON.parse(orient.stderr).error, /Reinstall @dads-framework\/toolbox/);
});
