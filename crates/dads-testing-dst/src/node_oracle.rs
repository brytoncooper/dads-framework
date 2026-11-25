//! Persistent Node 24 oracle worker pool + embedded workspace task runner.
//!
//! Supports native TypeScript transform (`enum`, parameter properties), `tsconfig.base.json` path
//! aliases, `.js`-to-`.ts` specifier mapping, directory-index/shadowing resolution, per-task `env`,
//! and isolated `worker_threads` ESM graphs per test evaluation.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

pub const DST_RUNNER_JS: &str = r#"import { existsSync, readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
let setupFile = null;
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--setup" && i + 1 < args.length) {
    setupFile = args[++i];
  } else {
    rest.push(args[i]);
  }
}

const [projectDir, ...selected] = rest;
const root = process.cwd();
installResolverHooks(root);

const files = selected.length > 0
  ? selected
  : readdirSync(join(root, projectDir))
      .filter((f) => f.endsWith(".test.ts"))
      .sort()
      .map((f) => `${projectDir}/${f}`);

if (setupFile) {
  await import(pathToFileURL(resolve(root, setupFile)).href);
}

let failed = 0;
for (const file of files) {
  try {
    await import(pathToFileURL(resolve(root, file)).href);
  } catch (error) {
    failed++;
    console.error(`FAIL ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.exitCode = failed > 0 ? 1 : 0;

function installResolverHooks(workspaceRoot) {
  let entries = [];
  const tsconfigPath = join(workspaceRoot, "tsconfig.base.json");
  if (existsSync(tsconfigPath)) {
    try {
      const parsed = JSON.parse(readFileSync(tsconfigPath, "utf8"));
      entries = Object.entries(parsed?.compilerOptions?.paths ?? {});
    } catch {
      entries = [];
    }
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      for (const [alias, targets] of entries) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        if (alias === specifier) {
          return { url: pathToFileURL(resolve(workspaceRoot, targets[0])).href, shortCircuit: true };
        }
        if (alias.endsWith("/*")) {
          const prefix = alias.slice(0, -1);
          if (specifier.startsWith(prefix)) {
            const tail = specifier.slice(prefix.length);
            const target = targets[0].replace(/\*$/, tail);
            return { url: pathToFileURL(resolve(workspaceRoot, target)).href, shortCircuit: true };
          }
        }
      }
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
        const baseDir = dirname(fileURLToPath(context.parentURL));
        if (specifier.endsWith(".js")) {
          const tsCandidate = resolve(baseDir, specifier.slice(0, -3) + ".ts");
          if (existsSync(tsCandidate)) {
            return { url: pathToFileURL(tsCandidate).href, shortCircuit: true };
          }
        }
        const directTs = resolve(baseDir, specifier + ".ts");
        if (existsSync(directTs)) {
          return { url: pathToFileURL(directTs).href, shortCircuit: true };
        }
        const indexTs = resolve(baseDir, specifier, "index.ts");
        if (existsSync(indexTs)) {
          return { url: pathToFileURL(indexTs).href, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
  });
}
"#;

const PERSISTENT_ORACLE_JS: &str = r#"import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";

const WORKER_SCRIPT = `
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

const { workspaceRoot, testFile, setupFile } = workerData;
let entries = [];
const tsconfigPath = join(workspaceRoot, "tsconfig.base.json");
if (existsSync(tsconfigPath)) {
  try {
    const parsed = JSON.parse(readFileSync(tsconfigPath, "utf8"));
    entries = Object.entries(parsed?.compilerOptions?.paths ?? {});
  } catch {
    entries = [];
  }
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    for (const [alias, targets] of entries) {
      if (!Array.isArray(targets) || targets.length === 0) continue;
      if (alias === specifier) {
        return { url: pathToFileURL(resolve(workspaceRoot, targets[0])).href, shortCircuit: true };
      }
      if (alias.endsWith("/*")) {
        const prefix = alias.slice(0, -1);
        if (specifier.startsWith(prefix)) {
          const tail = specifier.slice(prefix.length);
          const target = targets[0].replace(/\\*$/, tail);
          return { url: pathToFileURL(resolve(workspaceRoot, target)).href, shortCircuit: true };
        }
      }
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
      const baseDir = dirname(fileURLToPath(context.parentURL));
      if (specifier.endsWith(".js")) {
        const tsCandidate = resolve(baseDir, specifier.slice(0, -3) + ".ts");
        if (existsSync(tsCandidate)) {
          return { url: pathToFileURL(tsCandidate).href, shortCircuit: true };
        }
      }
      const directTs = resolve(baseDir, specifier + ".ts");
      if (existsSync(directTs)) {
        return { url: pathToFileURL(directTs).href, shortCircuit: true };
      }
      const indexTs = resolve(baseDir, specifier, "index.ts");
      if (existsSync(indexTs)) {
        return { url: pathToFileURL(indexTs).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

try {
  if (setupFile) {
    await import(pathToFileURL(resolve(workspaceRoot, setupFile)).href);
  }
  await import(pathToFileURL(resolve(workspaceRoot, testFile)).href);
  parentPort.postMessage({ ok: true, error: null });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
`;

function runOne(workspaceRoot, testFile, setupFile, extraEnv) {
  return new Promise((resolvePromise) => {
    const worker = new Worker(WORKER_SCRIPT, {
      eval: true,
      execArgv: ["--no-warnings", "--experimental-transform-types"],
      env: { ...process.env, ...(extraEnv ?? {}) },
      workerData: { workspaceRoot, testFile, setupFile },
    });
    let settled = false;
    worker.once("message", (msg) => {
      settled = true;
      resolvePromise(msg);
    });
    worker.once("error", (err) => {
      if (!settled) {
        settled = true;
        resolvePromise({ ok: false, error: err.message });
      }
    });
    worker.once("exit", (code) => {
      if (!settled) {
        settled = true;
        resolvePromise({ ok: code === 0, error: code === 0 ? null : `worker exit ${code}` });
      }
    });
  });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    const entries = await Promise.all(
      req.tests.map(async (item) => {
        const res = await runOne(req.workspaceRoot, item.file, item.setupFile ?? null, item.env ?? null);
        return [item.file, res];
      }),
    );
    const results = Object.fromEntries(entries);
    process.stdout.write(JSON.stringify({ ok: true, results }) + "\n");
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n",
    );
  }
});
"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleTestSpec {
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_file: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OracleRequest<'a> {
    workspace_root: &'a str,
    tests: &'a [OracleTestSpec],
}

#[derive(Debug, Clone, Deserialize)]
pub struct OracleTestOutcome {
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OracleResponse {
    ok: bool,
    #[serde(default)]
    results: BTreeMap<String, OracleTestOutcome>,
    error: Option<String>,
}

pub fn oracle_specs_with_override(
    base: &[OracleTestSpec],
    override_env: Option<&(String, String, String)>,
) -> Vec<OracleTestSpec> {
    let Some((target_file, key, value)) = override_env else {
        return base.to_vec();
    };
    base.iter()
        .cloned()
        .map(|mut spec| {
            if &spec.file == target_file {
                spec.env.insert(key.clone(), value.clone());
            }
            spec
        })
        .collect()
}

pub struct NodeOracleWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl NodeOracleWorker {
    pub fn spawn(node_bin: &Path) -> Result<Self, String> {
        let mut child = Command::new(node_bin)
            .args([
                "--no-warnings",
                "--experimental-transform-types",
                "--input-type=module",
                "-e",
                PERSISTENT_ORACLE_JS,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("failed to spawn node oracle worker: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "node oracle stdin unavailable".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "node oracle stdout unavailable".to_owned())?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    pub fn evaluate(
        &mut self,
        workspace_root: &Path,
        tests: &[OracleTestSpec],
    ) -> Result<BTreeMap<String, OracleTestOutcome>, String> {
        let root_str = workspace_root.to_string_lossy();
        let payload = serde_json::to_string(&OracleRequest {
            workspace_root: &root_str,
            tests,
        })
        .map_err(|error| format!("serialize oracle request: {error}"))?;
        writeln!(self.stdin, "{payload}")
            .map_err(|error| format!("write oracle request: {error}"))?;
        self.stdin
            .flush()
            .map_err(|error| format!("flush oracle request: {error}"))?;
        let mut line = String::new();
        let bytes = self
            .stdout
            .read_line(&mut line)
            .map_err(|error| format!("read oracle response: {error}"))?;
        if bytes == 0 {
            return Err("node oracle worker exited unexpectedly".to_owned());
        }
        let response: OracleResponse = serde_json::from_str(&line)
            .map_err(|error| format!("parse oracle response: {error}"))?;
        if !response.ok {
            return Err(response
                .error
                .unwrap_or_else(|| "unknown node oracle error".to_owned()));
        }
        Ok(response.results)
    }
}

impl Drop for NodeOracleWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
