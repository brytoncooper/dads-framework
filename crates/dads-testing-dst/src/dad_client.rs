//! Black-box protocol-v1 JSON client for invoking any compiled `dad-test` binary.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRequestPayload {
    pub schema_version: u32,
    pub operation: String,
    pub workspace_root: String,
    pub manifest_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    pub all: bool,
    pub only: bool,
    pub task_ids: Vec<String>,
    pub cache: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jobs: Option<u32>,
}

impl NativeRequestPayload {
    pub fn new(operation: &str, workspace_root: String) -> Self {
        Self {
            schema_version: 1,
            operation: operation.to_owned(),
            workspace_root,
            manifest_path: "dads.testing.json".to_owned(),
            base: None,
            head: None,
            all: false,
            only: false,
            task_ids: Vec::new(),
            cache: false,
            cache_dir: None,
            plan_file: None,
            jobs: Some(2),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeEnvelope {
    pub ok: bool,
    pub error: Option<String>,
    pub result: Option<NativeResult>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeResult {
    pub plan: PlanView,
    pub run: Option<RunView>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    pub tasks: Vec<PlannedTaskView>,
    #[serde(default)]
    pub issues: Vec<PlanIssueView>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedTaskView {
    pub id: String,
    pub decision: String,
    pub reason: String,
    #[serde(default)]
    pub widened: bool,
    pub project: String,
    #[serde(default)]
    pub selected_files: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanIssueView {
    pub code: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunView {
    pub tasks: Vec<ExecutedTaskView>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutedTaskView {
    pub id: String,
    pub status: String,
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub cached: bool,
}

pub struct DadInvocation {
    pub raw_plan_json: Option<String>,
    pub envelope: NativeEnvelope,
    pub exit_ok: bool,
}

pub fn invoke_dad(
    dad_bin: &Path,
    request: &NativeRequestPayload,
    extra_path: Option<&Path>,
) -> Result<DadInvocation, String> {
    let payload = serde_json::to_string(request)
        .map_err(|error| format!("serialize NativeRequest: {error}"))?;
    let mut command = Command::new(dad_bin);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = extra_path {
        let current = std::env::var_os("PATH").unwrap_or_default();
        let mut combined = dir.as_os_str().to_os_string();
        combined.push(":");
        combined.push(current);
        command.env("PATH", combined);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn {}: {error}", dad_bin.display()))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(payload.as_bytes())
            .map_err(|error| format!("write dad-test stdin: {error}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("wait dad-test: {error}"))?;
    let stdout = String::from_utf8(output.stdout)
        .map_err(|error| format!("non-utf8 dad-test stdout: {error}"))?;
    let raw_value: serde_json::Value = serde_json::from_str(&stdout).map_err(|error| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        format!("parse dad-test JSON ({error}): stdout={stdout} stderr={stderr}")
    })?;
    let raw_plan_json = raw_value
        .get("result")
        .and_then(|res| res.get("plan"))
        .and_then(|plan| serde_json::to_string(plan).ok());
    let envelope: NativeEnvelope = serde_json::from_value(raw_value)
        .map_err(|error| format!("decode NativeEnvelope: {error}"))?;
    Ok(DadInvocation {
        raw_plan_json,
        envelope,
        exit_ok: output.status.success(),
    })
}
