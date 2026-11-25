//! Persistent Node 24 oracle worker pool delegating embedded ESM scripts to `node_runner_js`.

use crate::node_oracle_js::PERSISTENT_ORACLE_JS;
pub use crate::node_runner_js::DST_RUNNER_JS;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const MAX_CALLS_PER_WORKER: usize = 20;

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
    node_bin: PathBuf,
    typescript_js: PathBuf,
    calls_served: usize,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl NodeOracleWorker {
    pub fn spawn(node_bin: &Path, typescript_js: &Path) -> Result<Self, String> {
        let (child, stdin, stdout) = spawn_oracle_child(node_bin, typescript_js)?;
        Ok(Self {
            node_bin: node_bin.to_path_buf(),
            typescript_js: typescript_js.to_path_buf(),
            calls_served: 0,
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    fn recycle(&mut self) -> Result<(), String> {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let (child, stdin, stdout) = spawn_oracle_child(&self.node_bin, &self.typescript_js)?;
        self.child = child;
        self.stdin = stdin;
        self.stdout = BufReader::new(stdout);
        self.calls_served = 0;
        Ok(())
    }

    pub fn evaluate(
        &mut self,
        workspace_root: &Path,
        tests: &[OracleTestSpec],
    ) -> Result<BTreeMap<String, OracleTestOutcome>, String> {
        if self.calls_served >= MAX_CALLS_PER_WORKER {
            self.recycle()?;
        }
        self.calls_served += 1;
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

fn spawn_oracle_child(
    node_bin: &Path,
    typescript_js: &Path,
) -> Result<(Child, ChildStdin, ChildStdout), String> {
    let mut child = Command::new(node_bin)
        .args([
            "--no-warnings",
            "--experimental-transform-types",
            "--input-type=module",
            "-e",
            PERSISTENT_ORACLE_JS,
        ])
        .env("DADS_DST_TS_PATH", typescript_js)
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
    Ok((child, stdin, stdout))
}
