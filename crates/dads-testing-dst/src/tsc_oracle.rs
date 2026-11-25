//! Persistent TypeScript Compiler API oracle worker (`ts.createProgram`) + task runner script.
//!
//! Keeps one Node 24 process per DST worker thread with `node_modules/typescript/lib/typescript.js`
//! loaded once and stdlib `lib.*.d.ts` `SourceFile` ASTs cached in memory so each scenario
//! typecheck evaluates in ~5-20ms.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

pub const DST_TYPECHECK_JS: &str = r#"import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const [tsPath, tsconfigRel] = process.argv.slice(2);
if (!tsPath || !tsconfigRel) {
  console.error("usage: dst-typecheck.mjs <typescript.js> <tsconfig.json>");
  process.exit(2);
}

const require = createRequire(import.meta.url);
const ts = require(tsPath);
const configPath = resolve(process.cwd(), tsconfigRel);
const readRes = ts.readConfigFile(configPath, ts.sys.readFile);
if (readRes.error) {
  console.error(ts.flattenDiagnosticMessageText(readRes.error.messageText, "\n"));
  process.exit(1);
}
const parsed = ts.parseJsonConfigFileContent(readRes.config, ts.sys, dirname(configPath));
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const diagnostics = ts.getPreEmitDiagnostics(program).filter(
  (d) => d.category === ts.DiagnosticCategory.Error,
);
if (diagnostics.length > 0) {
  for (const diag of diagnostics) {
    const msg = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
    const loc = diag.file ? `${diag.file.fileName}` : "<global>";
    console.error(`TS${diag.code} ${loc}: ${msg}`);
  }
  process.exit(1);
}
process.exit(0);
"#;

const PERSISTENT_TSC_ORACLE_JS: &str = r#"import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

const tsPath = process.argv[1];
const require = createRequire(import.meta.url);
const ts = require(tsPath);
const libCache = new Map();

function checkProject(workspaceRoot, tsconfigRel) {
  const configPath = resolve(workspaceRoot, tsconfigRel);
  const readRes = ts.readConfigFile(configPath, ts.sys.readFile);
  if (readRes.error) {
    return {
      ok: true,
      passed: false,
      errors: [ts.flattenDiagnosticMessageText(readRes.error.messageText, "\n")],
    };
  }
  const parsed = ts.parseJsonConfigFileContent(readRes.config, ts.sys, dirname(configPath));
  if (parsed.errors && parsed.errors.length > 0) {
    return {
      ok: true,
      passed: false,
      errors: parsed.errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n")),
    };
  }
  const host = ts.createCompilerHost(parsed.options, true);
  const origGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNew) => {
    const isStdLib = fileName.includes("/typescript/lib/lib.") && fileName.endsWith(".d.ts");
    if (isStdLib) {
      const cacheKey = `${fileName}:${String(languageVersion)}`;
      const cached = libCache.get(cacheKey);
      if (cached) return cached;
      const sf = origGetSourceFile(fileName, languageVersion, onError, shouldCreateNew);
      if (sf) libCache.set(cacheKey, sf);
      return sf;
    }
    return origGetSourceFile(fileName, languageVersion, onError, true);
  };
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    host,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  const errors = diagnostics.map((diag) => {
    const msg = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
    const loc = diag.file ? diag.file.fileName : "<global>";
    return `TS${diag.code} ${loc}: ${msg}`;
  });
  return { ok: true, passed: errors.length === 0, errors };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    const out = checkProject(req.workspaceRoot, req.tsconfigPath);
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        passed: false,
        errors: [],
        error: error instanceof Error ? error.message : String(error),
      }) + "\n",
    );
  }
});
"#;

#[derive(Debug, Clone, Deserialize)]
pub struct TscOracleOutcome {
    pub passed: bool,
    #[serde(default)]
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TscOracleRequest<'a> {
    workspace_root: &'a str,
    tsconfig_path: &'a str,
}

#[derive(Debug, Deserialize)]
struct TscOracleResponse {
    ok: bool,
    #[serde(default)]
    passed: bool,
    #[serde(default)]
    errors: Vec<String>,
    error: Option<String>,
}

pub fn find_typescript_js() -> Result<PathBuf, String> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest_dir.join("../../node_modules/typescript/lib/typescript.js"),
        manifest_dir.join("../../../node_modules/typescript/lib/typescript.js"),
    ];
    for candidate in &candidates {
        if candidate.is_file() {
            return candidate
                .canonicalize()
                .map_err(|e| format!("canonicalize typescript.js: {e}"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let mut cursor = Some(cwd.as_path());
        while let Some(dir) = cursor {
            let candidate = dir.join("node_modules/typescript/lib/typescript.js");
            if candidate.is_file() {
                return candidate
                    .canonicalize()
                    .map_err(|e| format!("canonicalize typescript.js: {e}"));
            }
            cursor = dir.parent();
        }
    }
    Err("could not locate node_modules/typescript/lib/typescript.js".to_owned())
}

pub struct TscOracleWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl TscOracleWorker {
    pub fn spawn(node_bin: &Path, typescript_js: &Path) -> Result<Self, String> {
        let mut child = Command::new(node_bin)
            .args([
                "--no-warnings",
                "--input-type=module",
                "-e",
                PERSISTENT_TSC_ORACLE_JS,
            ])
            .arg(typescript_js)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("failed to spawn tsc oracle worker: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "tsc oracle stdin unavailable".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "tsc oracle stdout unavailable".to_owned())?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    pub fn check(
        &mut self,
        workspace_root: &Path,
        tsconfig_path: &str,
    ) -> Result<TscOracleOutcome, String> {
        let root_str = workspace_root.to_string_lossy();
        let payload = serde_json::to_string(&TscOracleRequest {
            workspace_root: &root_str,
            tsconfig_path,
        })
        .map_err(|error| format!("serialize tsc oracle request: {error}"))?;
        writeln!(self.stdin, "{payload}")
            .map_err(|error| format!("write tsc oracle request: {error}"))?;
        self.stdin
            .flush()
            .map_err(|error| format!("flush tsc oracle request: {error}"))?;
        let mut line = String::new();
        let bytes = self
            .stdout
            .read_line(&mut line)
            .map_err(|error| format!("read tsc oracle response: {error}"))?;
        if bytes == 0 {
            return Err("tsc oracle worker exited unexpectedly".to_owned());
        }
        let response: TscOracleResponse = serde_json::from_str(&line)
            .map_err(|error| format!("parse tsc oracle response: {error}"))?;
        if !response.ok {
            return Err(response
                .error
                .unwrap_or_else(|| "unknown tsc oracle error".to_owned()));
        }
        Ok(TscOracleOutcome {
            passed: response.passed,
            errors: response.errors,
        })
    }
}

impl Drop for TscOracleWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
