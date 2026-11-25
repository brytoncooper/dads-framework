use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct BoundaryWorkspace {
    pub root: PathBuf,
}

impl BoundaryWorkspace {
    pub fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "dad-test-boundaries-{label}-{}-{nonce}-{seq}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create temp workspace");
        Self { root }
    }

    pub fn write(&self, rel: &str, content: &str) {
        let full = self.root.join(rel);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).expect("create parent dirs");
        }
        fs::write(&full, content).expect("write file");
    }

    fn git(&self, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(&self.root)
            .output()
            .expect("run git");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    pub fn init_git_and_commit(&self, message: &str) {
        if !self.root.join(".git").exists() {
            self.git(&["init", "--quiet"]);
            self.git(&["config", "user.email", "testing@dads.invalid"]);
            self.git(&["config", "user.name", "Dads Testing"]);
        }
        self.git(&["add", "--all"]);
        self.git(&["commit", "--quiet", "--message", message]);
    }

    fn run_request(&self, request: Value) -> Value {
        let mut child = Command::new(env!("CARGO_BIN_EXE_dad-test"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn dad-test");
        child
            .stdin
            .as_mut()
            .expect("stdin")
            .write_all(request.to_string().as_bytes())
            .expect("write request");
        let output = child.wait_with_output().expect("wait dad-test");
        serde_json::from_slice(&output.stdout).expect("parse JSON response")
    }

    pub fn check_boundaries(
        &self,
        base: Option<&str>,
        head: Option<&str>,
        config: Option<&str>,
    ) -> Value {
        let mut req = json!({
            "schemaVersion": 1,
            "operation": "check-boundaries",
            "workspaceRoot": self.root.to_string_lossy(),
            "all": false,
            "taskIds": [],
        });
        if let Some(b) = base {
            req["base"] = json!(b);
        }
        if let Some(h) = head {
            req["head"] = json!(h);
        }
        if let Some(c) = config {
            req["boundariesConfigPath"] = json!(c);
        }
        self.run_request(req)
    }
}

impl Drop for BoundaryWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub fn setup_standard_workspace(ws: &BoundaryWorkspace, boundaries: Value) {
    ws.write(
        "tsconfig.base.json",
        &json!({
            "compilerOptions": {
                "paths": {
                    "@ws/ui": ["libs/ui/src/index.ts"],
                    "@ws/ui/*": ["libs/ui/src/*"],
                    "@ws/server": ["libs/server/src/index.ts"],
                    "@ws/server/*": ["libs/server/src/*"],
                    "@ws/shared": ["libs/shared/src/index.ts"],
                    "@ws/buildable": ["libs/buildable/src/index.ts"],
                    "@ws/non-buildable": ["libs/non-buildable/src/index.ts"]
                }
            }
        })
        .to_string(),
    );
    ws.write(
        "libs/ui/project.json",
        r#"{ "name": "ui", "projectType": "library", "tags": ["env:browser"] }"#,
    );
    ws.write(
        "libs/server/project.json",
        r#"{ "name": "server", "projectType": "library", "tags": ["env:server"] }"#,
    );
    ws.write(
        "libs/shared/project.json",
        r#"{ "name": "shared", "projectType": "library", "tags": ["shared"] }"#,
    );
    ws.write(
        "libs/buildable/project.json",
        r#"{ "name": "buildable", "projectType": "library", "tags": ["shared"], "targets": { "build": {} } }"#,
    );
    ws.write(
        "libs/non-buildable/project.json",
        r#"{ "name": "non-buildable", "projectType": "library", "tags": ["shared"] }"#,
    );
    ws.write(
        "dads.testing.json",
        &json!({
            "schemaVersion": 1,
            "workspace": {
                "root": ".",
                "fullFallback": { "taskIds": ["ui:test"] },
                "boundaries": boundaries
            },
            "projects": [
                { "id": "ui", "root": "libs/ui", "fallbackDependencies": [] },
                { "id": "server", "root": "libs/server", "fallbackDependencies": [] },
                { "id": "shared", "root": "libs/shared", "fallbackDependencies": [] },
                { "id": "buildable", "root": "libs/buildable", "fallbackDependencies": [] },
                { "id": "non-buildable", "root": "libs/non-buildable", "fallbackDependencies": [] }
            ],
            "tasks": [
                {
                    "id": "ui:test",
                    "project": "ui",
                    "kind": "test",
                    "execution": { "executable": "node", "args": ["-e", "process.exit(0)"] },
                    "dependsOn": [],
                    "impact": { "mode": "project" }
                }
            ]
        })
        .to_string(),
    );
}
