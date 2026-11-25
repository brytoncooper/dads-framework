//! End-to-end `hotspots` tests through the shipped `dad-test` binary using real Oxc parsing.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]

use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct HotspotsWorkspace(PathBuf);

impl HotspotsWorkspace {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "dad-test-hotspots-cli-{label}-{}-{nonce}-{seq}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn write(&self, rel: &str, content: &str) {
        let path = self.0.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn git_init(&self) {
        for args in [
            &["init", "--quiet"][..],
            &["config", "user.email", "testing@dads.invalid"],
            &["config", "user.name", "Dads Testing"],
            &["add", "--all"],
            &["commit", "--quiet", "--message", "baseline"],
        ] {
            let output = Command::new("git")
                .args(args)
                .current_dir(&self.0)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    fn run_hotspots(&self, hotspots_options: Option<Value>) -> Value {
        let mut child = Command::new(env!("CARGO_BIN_EXE_dad-test"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut req = json!({
            "schemaVersion": 1,
            "operation": "hotspots",
            "workspaceRoot": self.0.to_string_lossy(),
            "all": false,
            "taskIds": [],
        });
        if let Some(opts) = hotspots_options {
            req["hotspots"] = opts;
        }
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(req.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["result"]["operation"], "hotspots");
        response["result"]["hotspots"].clone()
    }
}

impl Drop for HotspotsWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn detects_oxc_barrel_forms_and_computes_real_blast_radius() {
    let ws = HotspotsWorkspace::new("oxc-barrels");
    ws.write(
        "dads.testing.json",
        &json!({
            "schemaVersion": 1,
            "workspace": {
                "root": ".",
                "fullFallback": { "taskIds": ["core:test", "app-a:test", "app-b:test"] }
            },
            "projects": [
                { "id": "core", "root": "packages/core", "fallbackDependencies": [] },
                { "id": "app-a", "root": "packages/app-a", "fallbackDependencies": ["core"] },
                { "id": "app-b", "root": "packages/app-b", "fallbackDependencies": ["core"] }
            ],
            "tasks": [
                {
                    "id": "core:test",
                    "project": "core",
                    "kind": "test",
                    "execution": { "executable": "true" },
                    "dependsOn": [],
                    "impact": { "mode": "project" }
                },
                {
                    "id": "app-a:test",
                    "project": "app-a",
                    "kind": "test",
                    "execution": { "executable": "true" },
                    "dependsOn": [],
                    "impact": { "mode": "project" }
                },
                {
                    "id": "app-b:test",
                    "project": "app-b",
                    "kind": "test",
                    "execution": { "executable": "true" },
                    "dependsOn": [],
                    "impact": { "mode": "project" }
                }
            ]
        })
        .to_string(),
    );

    // Core implementation file
    ws.write(
        "packages/core/src/math.ts",
        "export function add(a: number, b: number): number { return a + b; }\n",
    );
    // Named re-export barrel: export { ... } from
    ws.write(
        "packages/core/src/named-barrel.ts",
        "export { add } from \"./math.js\";\n",
    );
    // Star re-export barrel: export * from
    ws.write(
        "packages/core/src/index.ts",
        "export * from \"./named-barrel.js\";\n",
    );
    // Non-barrel index.ts with only local implementation
    ws.write(
        "packages/app-a/src/index.ts",
        "import { add } from \"../../core/src/index.js\";\nexport function runA(): number { return add(1, 2); }\n",
    );
    // Second consumer project
    ws.write(
        "packages/app-b/src/main.ts",
        "import { add } from \"../../core/src/index.js\";\nexport function runB(): number { return add(3, 4); }\n",
    );
    ws.git_init();

    // Even though all tasks use `project` impact, `hotspots` must still analyze the Oxc graph.
    let all = ws.run_hotspots(None);
    assert_eq!(all["summary"]["totalFiles"], 5, "{all}");
    assert_eq!(all["summary"]["totalBarrels"], 2, "{all}");

    let files = all["files"].as_array().unwrap();
    // math.ts -> named-barrel.ts -> core/index.ts -> app-a/index.ts & app-b/main.ts
    assert_eq!(files[0]["path"], "packages/core/src/math.ts");
    assert_eq!(files[0]["affectedProjects"], 3);
    assert_eq!(files[0]["affectedFiles"], 5);
    assert_eq!(files[0]["directImporters"], 1);
    assert_eq!(files[0]["isBarrel"], false);

    assert_eq!(files[1]["path"], "packages/core/src/named-barrel.ts");
    assert_eq!(files[1]["affectedProjects"], 3);
    assert_eq!(files[1]["affectedFiles"], 4);
    assert_eq!(files[1]["directImporters"], 1);
    assert_eq!(files[1]["isBarrel"], true);

    assert_eq!(files[2]["path"], "packages/core/src/index.ts");
    assert_eq!(files[2]["affectedProjects"], 3);
    assert_eq!(files[2]["affectedFiles"], 3);
    assert_eq!(files[2]["directImporters"], 2);
    assert_eq!(files[2]["isBarrel"], true);

    // app-a/src/index.ts is NOT a barrel even though its filename is index.ts
    let app_a_index = files
        .iter()
        .find(|f| f["path"] == "packages/app-a/src/index.ts")
        .unwrap();
    assert_eq!(app_a_index["isBarrel"], false);

    // Test barrelsOnly + limit
    let barrels = ws.run_hotspots(Some(json!({
        "barrelsOnly": true,
        "limit": 1,
        "minProjects": 2
    })));
    let barrel_files = barrels["files"].as_array().unwrap();
    assert_eq!(barrel_files.len(), 1);
    assert_eq!(barrel_files[0]["path"], "packages/core/src/named-barrel.ts");
    assert_eq!(barrel_files[0]["isBarrel"], true);
}
