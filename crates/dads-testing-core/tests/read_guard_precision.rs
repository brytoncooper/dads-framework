#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]

use dads_testing_core::graph::{DependencyGraph, ModuleNode};
use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, execute_request_with_graph,
};
use std::error::Error;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

struct TempWorkspace(PathBuf);

impl TempWorkspace {
    fn new(prefix: &str) -> Result<Self, Box<dyn Error>> {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let seq = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "dads-rgp-{prefix}-{}-{nanos}-{seq}",
            std::process::id()
        ));
        fs::create_dir_all(&dir)?;
        Ok(Self(fs::canonicalize(&dir)?))
    }

    fn write(&self, rel: &str, contents: &str) -> Result<(), Box<dyn Error>> {
        let full = self.0.join(rel);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(full, contents)?;
        Ok(())
    }

    fn init_git(&self) -> Result<(), Box<dyn Error>> {
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.name", "Test"],
            vec!["config", "user.email", "test@example.invalid"],
            vec!["add", "."],
            vec!["commit", "-qm", "baseline"],
        ] {
            let status = Command::new("git")
                .args(&args)
                .current_dir(&self.0)
                .status()?;
            assert!(status.success(), "git {args:?} failed");
        }
        Ok(())
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn ignores_node_modules_enoent_probes_eval_code_policy_files_and_gitignored_paths()
-> Result<(), Box<dyn Error>> {
    let ws = TempWorkspace::new("precision")?;
    ws.write("package.json", r#"{"name":"precision-ws","type":"module"}"#)?;
    ws.write(".gitignore", "*.env\n.claude/launch.json\n")?;
    ws.write(".nvmrc", "24.20.0\n")?;
    ws.write(".prettierrc", "{}\n")?;
    ws.write("settings/real-undeclared.json", r#"{"real":true}"#)?;
    ws.write("scripts/undeclared-helper.mjs", "process.exit(0);\n")?;
    ws.write(
        "node_modules/fake-probe-lib/index.mjs",
        concat!(
            "import { existsSync, readFileSync } from 'node:fs';\n",
            "export function probeMissing() {\n",
            "  existsSync('build/Debug');\n",
            "  existsSync('build/Release');\n",
            "  existsSync('prebuilds');\n",
            "  existsSync('libs/.prettierrc.cjs');\n",
            "}\n",
            "export function readReal(p) { return readFileSync(p, 'utf8'); }\n",
        ),
    )?;
    ws.write(
        "apps/web/src/reader.test.mjs",
        concat!(
            "import { readFileSync } from 'node:fs';\n",
            "import { spawnSync } from 'node:child_process';\n",
            "import { probeMissing, readReal } from '../../../node_modules/fake-probe-lib/index.mjs';\n",
            "probeMissing();\n",
            "readFileSync('.nvmrc', 'utf8');\n",
            "readFileSync('.prettierrc', 'utf8');\n",
            "readFileSync('apps/api/.env', 'utf8');\n",
            "readFileSync('.claude/launch.json', 'utf8');\n",
            "spawnSync(process.execPath, ['-e', 'const x = 1;\\nprocess.exit(0);']);\n",
            "spawnSync(process.execPath, ['--input-type', 'module', '-e', 'process.exit(0);']);\n",
            "readReal('settings/real-undeclared.json');\n",
            "spawnSync(process.execPath, ['scripts/undeclared-helper.mjs']);\n",
        ),
    )?;
    ws.write(
        "dads.testing.json",
        r#"{
  "schemaVersion": 1,
  "workspace": {
    "fullFallback": { "taskIds": ["web:test"] },
    "enforceDeclaredReads": true
  },
  "projects": [{ "id": "web", "root": "apps/web" }],
  "tasks": [{
    "id": "web:test",
    "project": "web",
    "kind": "test",
    "impact": { "mode": "reachability", "paths": [] },
    "execution": {
      "executable": "node",
      "args": ["apps/web/src/reader.test.mjs"],
      "cwd": ".",
      "shell": false
    }
  }]
}"#,
    )?;
    ws.init_git()?;
    // Create gitignored local files AFTER baseline commit so they are untracked + ignored.
    ws.write("apps/api/.env", "SECRET=1\n")?;
    ws.write(".claude/launch.json", "{}\n")?;

    let graph = DependencyGraph::new(
        vec![ModuleNode {
            path: "apps/web/src/reader.test.mjs".into(),
            language: "javascript".into(),
            imports: Vec::new(),
            declarations: Vec::new(),
            references: Vec::new(),
        }],
        Vec::new(),
    );

    let resp = execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: ws.0.to_string_lossy().into_owned(),
            only: true,
            task_ids: vec!["web:test".into()],
            enforce_declared_reads: true,
            ..NativeRequest::default()
        },
        Some(graph),
    );
    assert!(resp.ok, "{resp:?}");
    let run = resp
        .result
        .ok_or("missing result")?
        .run
        .ok_or("missing run")?;
    assert_eq!(run.exit_code, 1);
    let test = run
        .tasks
        .iter()
        .find(|t| t.id == "web:test")
        .ok_or("missing web:test")?;
    let paths: Vec<&str> = test
        .undeclared_reads
        .iter()
        .map(|r| r.path.as_str())
        .collect();
    assert_eq!(
        paths,
        vec![
            "scripts/undeclared-helper.mjs",
            "settings/real-undeclared.json",
        ],
        "expected only real tracked undeclared reads, got {paths:?}"
    );
    Ok(())
}
