#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]

use dads_testing_core::graph::{DependencyGraph, ImportFact, ImportKind, ModuleNode, SourceSpan};
use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, execute_request_with_graph,
};
use std::collections::BTreeSet;
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

#[test]
fn file_read_edge_and_root_project_import_do_not_enable_allow_all() -> Result<(), Box<dyn Error>> {
    let ws = TempWorkspace::new("root-catchall")?;
    ws.write("package.json", r#"{"name":"root-catchall-ws","type":"module"}"#)?;
    ws.write("vitest.config.mts", "export const shared = true;\n")?;
    ws.write("root-secret.txt", "root-file\n")?;
    ws.write("pacts/undeclared.json", "{}\n")?;
    ws.write(
        "apps/app/src/suite.test.mjs",
        concat!(
            "import { readFileSync } from 'node:fs';\n",
            "readFileSync('vitest.config.mts', 'utf8');\n",
            "readFileSync('root-secret.txt', 'utf8');\n",
            "readFileSync('pacts/undeclared.json', 'utf8');\n",
        ),
    )?;
    ws.write(
        "dads.testing.json",
        r#"{
  "schemaVersion": 1,
  "workspace": {
    "fullFallback": { "taskIds": ["app:test"] },
    "enforceDeclaredReads": true
  },
  "projects": [
    { "id": "root", "root": "." },
    { "id": "app", "root": "apps/app" }
  ],
  "tasks": [{
    "id": "app:test",
    "project": "app",
    "kind": "test",
    "impact": { "mode": "reachability", "paths": [] },
    "execution": {
      "executable": "node",
      "args": ["apps/app/src/suite.test.mjs"],
      "cwd": ".",
      "shell": false
    }
  }]
}"#,
    )?;
    ws.init_git()?;

    let graph = DependencyGraph::new(
        vec![
            ModuleNode {
                path: "apps/app/src/suite.test.mjs".into(),
                language: "javascript".into(),
                imports: vec![
                    ImportFact {
                        specifier: "fs:root-secret.txt".into(),
                        span: SourceSpan { start: 0, end: 1 },
                        resolved_path: Some("root-secret.txt".into()),
                        kind: ImportKind::FileRead,
                        type_only: false,
                        requested_symbols: BTreeSet::new(),
                        namespace_import: false,
                        reexport_all: false,
                        reexport_namespace: None,
                        position: None,
                        export_deps: None,
                        member_reads: None,
                    },
                    ImportFact {
                        specifier: "../../../vitest.config.mts".into(),
                        span: SourceSpan { start: 0, end: 1 },
                        resolved_path: Some("vitest.config.mts".into()),
                        kind: ImportKind::Runtime,
                        type_only: false,
                        requested_symbols: BTreeSet::from(["shared".into()]),
                        namespace_import: false,
                        reexport_all: false,
                        reexport_namespace: None,
                        position: None,
                        export_deps: None,
                        member_reads: None,
                    },
                ],
                declarations: Vec::new(),
                references: Vec::new(),
            },
            ModuleNode {
                path: "root-secret.txt".into(),
                language: "asset".into(),
                imports: Vec::new(),
                declarations: Vec::new(),
                references: Vec::new(),
            },
            ModuleNode {
                path: "vitest.config.mts".into(),
                language: "typescript".into(),
                imports: Vec::new(),
                declarations: Vec::new(),
                references: Vec::new(),
            },
        ],
        Vec::new(),
    );

    let resp = execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: ws.0.to_string_lossy().into_owned(),
            only: true,
            task_ids: vec!["app:test".into()],
            ..NativeRequest::default()
        },
        Some(graph),
    );
    assert!(resp.ok, "{resp:?}");
    let result = resp.result.ok_or("missing result")?;
    let decision = result
        .plan
        .tasks
        .iter()
        .find(|t| t.id == "app:test")
        .ok_or("missing app:test plan")?;
    let allowlist = decision
        .read_guard_allowlist
        .as_ref()
        .ok_or("expected readGuardAllowlist on plan decision")?;
    assert!(
        !allowlist.allowed_project_roots.iter().any(|r| r == "."),
        "subproject must never inherit workspace root '.': {:?}",
        allowlist.allowed_project_roots
    );
    let run = result.run.ok_or("missing run")?;
    assert_eq!(run.exit_code, 1);
    let test = run
        .tasks
        .iter()
        .find(|t| t.id == "app:test")
        .ok_or("missing app:test")?;
    let paths: Vec<&str> = test
        .undeclared_reads
        .iter()
        .map(|r| r.path.as_str())
        .collect();
    assert_eq!(paths, vec!["pacts/undeclared.json"], "{paths:?}");
    Ok(())
}

#[test]
fn glob_impact_paths_allow_directory_traversal_and_meta_but_block_unmatched_content()
-> Result<(), Box<dyn Error>> {
    let ws = TempWorkspace::new("glob-walk")?;
    ws.write("package.json", r#"{"name":"glob-walk-ws","type":"module"}"#)?;
    ws.write("apps/api/sub/writer.ts", "export const ok = 1;\n")?;
    ws.write("apps/api/sub/README.md", "# readme\n")?;
    ws.write("pacts/command-api.json", "{}\n")?;
    ws.write("pacts/other.json", "{}\n")?;
    ws.write(
        "apps/app/src/walk.test.mjs",
        concat!(
            "import { readdirSync, readFileSync, statSync } from 'node:fs';\n",
            "readdirSync('apps/api');\n",
            "readdirSync('apps/api/sub');\n",
            "statSync('apps/api/sub/README.md');\n",
            "readFileSync('apps/api/sub/writer.ts', 'utf8');\n",
            "readdirSync('pacts');\n",
            "statSync('pacts/other.json');\n",
            "readFileSync('pacts/command-api.json', 'utf8');\n",
            // Unmatched content reads MUST still fail even after statSync!
            "readFileSync('apps/api/sub/README.md', 'utf8');\n",
            "readFileSync('pacts/other.json', 'utf8');\n",
        ),
    )?;
    ws.write(
        "dads.testing.json",
        r#"{
  "schemaVersion": 1,
  "workspace": {
    "fullFallback": { "taskIds": ["app:test"] },
    "enforceDeclaredReads": true
  },
  "projects": [{ "id": "app", "root": "apps/app" }],
  "tasks": [{
    "id": "app:test",
    "project": "app",
    "kind": "test",
    "impact": { "mode": "reachability", "paths": ["apps/api/**/*.ts", "pacts/command-*.json"] },
    "execution": {
      "executable": "node",
      "args": ["apps/app/src/walk.test.mjs"],
      "cwd": ".",
      "shell": false
    }
  }]
}"#,
    )?;
    ws.init_git()?;

    let graph = DependencyGraph::new(
        vec![ModuleNode {
            path: "apps/app/src/walk.test.mjs".into(),
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
            task_ids: vec!["app:test".into()],
            ..NativeRequest::default()
        },
        Some(graph),
    );
    assert!(resp.ok, "{resp:?}");
    let run = resp.result.ok_or("missing result")?.run.ok_or("missing run")?;
    assert_eq!(run.exit_code, 1);
    let test = run
        .tasks
        .iter()
        .find(|t| t.id == "app:test")
        .ok_or("missing app:test")?;
    let paths: Vec<&str> = test
        .undeclared_reads
        .iter()
        .map(|r| r.path.as_str())
        .collect();
    assert_eq!(
        paths,
        vec!["apps/api/sub/README.md", "pacts/other.json"],
        "glob traversal must allow readdir/stat under glob prefix but block unmatched content reads: {paths:?}"
    );
    Ok(())
}

#[test]
fn root_spanning_glob_allows_dir_traversal_but_blocks_unmatched_content()
-> Result<(), Box<dyn Error>> {
    let ws = TempWorkspace::new("root-glob-walk")?;
    ws.write("package.json", r#"{"name":"root-glob-ws","type":"module"}"#)?;
    ws.write("other/nested/project.json", "{}\n")?;
    ws.write("other/nested/secret.txt", "nope\n")?;
    ws.write(
        "apps/app/src/scan.test.mjs",
        concat!(
            "import { readdirSync, readFileSync, statSync } from 'node:fs';\n",
            "readdirSync('.');\n",
            "readdirSync('other');\n",
            "readdirSync('other/nested');\n",
            "statSync('other/nested/secret.txt');\n",
            "readFileSync('other/nested/project.json', 'utf8');\n",
            "readFileSync('other/nested/secret.txt', 'utf8');\n",
        ),
    )?;
    ws.write(
        "dads.testing.json",
        r#"{
  "schemaVersion": 1,
  "workspace": {
    "fullFallback": { "taskIds": ["app:test"] },
    "enforceDeclaredReads": true
  },
  "projects": [{ "id": "app", "root": "apps/app" }],
  "tasks": [{
    "id": "app:test",
    "project": "app",
    "kind": "test",
    "impact": { "mode": "reachability", "paths": ["**/project.json"] },
    "execution": {
      "executable": "node",
      "args": ["apps/app/src/scan.test.mjs"],
      "cwd": ".",
      "shell": false
    }
  }]
}"#,
    )?;
    ws.init_git()?;

    let graph = DependencyGraph::new(
        vec![ModuleNode {
            path: "apps/app/src/scan.test.mjs".into(),
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
            task_ids: vec!["app:test".into()],
            ..NativeRequest::default()
        },
        Some(graph),
    );
    assert!(resp.ok, "{resp:?}");
    let run = resp.result.ok_or("missing result")?.run.ok_or("missing run")?;
    assert_eq!(run.exit_code, 1);
    let test = run
        .tasks
        .iter()
        .find(|t| t.id == "app:test")
        .ok_or("missing app:test")?;
    let paths: Vec<&str> = test
        .undeclared_reads
        .iter()
        .map(|r| r.path.as_str())
        .collect();
    assert_eq!(
        paths,
        vec!["other/nested/secret.txt"],
        "**/project.json must allow directory walking from '.' but block unmatched content reads: {paths:?}"
    );
    Ok(())
}
