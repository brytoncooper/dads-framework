//! A throwaway git workspace, and one plan request sent through the shipped binary.
//!
//! The binary is the only thing under test here, so a request goes in on stdin and the emitted
//! plan comes back as JSON, exactly as a host sends and reads it.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static WORKSPACE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct TemporaryWorkspace(pub PathBuf);

impl TemporaryWorkspace {
    /// A committed workspace holding one `app` project and the manifest it is described by.
    pub fn create(label: &str, manifest: &Value) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock must be after the epoch")
            .as_nanos();
        let sequence = WORKSPACE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "dad-test-{label}-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("the workspace must be creatable");
        let workspace = Self(path);
        fs::create_dir(workspace.0.join("app")).expect("the project root must be creatable");
        workspace.write("app/index.ts", "export const value = 1;\n");
        workspace.write("dads.testing.json", &manifest.to_string());
        workspace.git(&["init", "--quiet"]);
        workspace.git(&["config", "user.email", "testing@dads.invalid"]);
        workspace.git(&["config", "user.name", "Dads Testing"]);
        workspace.git(&["add", "--all"]);
        workspace.git(&["commit", "--quiet", "--message", "baseline"]);
        workspace
    }

    pub fn write(&self, relative: &str, contents: &str) {
        let full = self.0.join(relative);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).expect("parent directory must be creatable");
        }
        fs::write(full, contents).expect("the workspace file must be writable");
    }

    /// One plan request through the shipped binary, exactly as a caller sends it.
    pub fn plan(&self) -> Value {
        let response = self.send_request(serde_json::json!({
            "schemaVersion": 1,
            "operation": "plan",
            "workspaceRoot": self.0.to_string_lossy(),
            "all": false,
            "taskIds": [],
        }));
        assert_eq!(response["ok"], true, "{response}");
        response["result"]["plan"].clone()
    }

    pub fn send_request(&self, request: Value) -> Value {
        let mut child = Command::new(env!("CARGO_BIN_EXE_dad-test"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("dad-test must start");
        child
            .stdin
            .as_mut()
            .expect("stdin must be piped")
            .write_all(request.to_string().as_bytes())
            .expect("the request must be writable");
        let output = child.wait_with_output().expect("dad-test must finish");
        serde_json::from_slice(&output.stdout).expect("dad-test must answer with one JSON response")
    }

    pub fn git(&self, arguments: &[&str]) {
        let output = Command::new("git")
            .args(arguments)
            .current_dir(&self.0)
            .output()
            .expect("git must start");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

impl Drop for TemporaryWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Every issue code an emitted plan carries, in the order the plan emitted them.
pub fn issue_codes(plan: &Value) -> Vec<String> {
    plan["issues"]
        .as_array()
        .expect("issues must be an array")
        .iter()
        .map(|issue| {
            issue["code"]
                .as_str()
                .expect("an issue must carry a code")
                .to_owned()
        })
        .collect()
}
