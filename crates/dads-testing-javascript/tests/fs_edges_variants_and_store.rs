#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use dads_testing_core::{NativeRequest, Operation, execute_request_with_graph};
use dads_testing_javascript::{JavaScriptFrontend, analyze_workspace};
use dads_testing_store::{SnapshotAction, load_or_update};
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct StoreFixture {
    root: PathBuf,
}

impl StoreFixture {
    fn new(label: &str) -> Self {
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "dads-js-fs-store-{label}-{}-{seq}",
            std::process::id()
        ));
        let _ = remove_dir_all(&root);
        create_dir_all(&root).expect("create temp fixture");
        Self { root }
    }

    fn write(&self, rel: &str, content: &str) {
        let full = self.root.join(rel);
        if let Some(parent) = full.parent() {
            create_dir_all(parent).expect("create parent dirs");
        }
        write(&full, content).expect("write file");
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

    fn init_commit(&self) {
        self.git(&["init", "-q"]);
        self.git(&["config", "user.email", "test@dads.invalid"]);
        self.git(&["config", "user.name", "Dads Test"]);
        self.git(&["add", "."]);
        self.git(&["commit", "-qm", "baseline"]);
    }

    fn request(&self) -> NativeRequest {
        NativeRequest {
            schema_version: 1,
            operation: Operation::Plan,
            workspace_root: self.root.display().to_string(),
            base: Some("HEAD".to_owned()),
            ..NativeRequest::default()
        }
    }
}

impl Drop for StoreFixture {
    fn drop(&mut self) {
        let _ = remove_dir_all(&self.root);
    }
}

#[test]
fn detects_commonjs_fs_promises_stat_open_and_ignores_bare_relative_const_arrays() {
    let fixture = StoreFixture::new("fs-variants");
    fixture.write("data/a.json", r#"{ "a": 1 }"#);
    fixture.write("data/b.json", r#"{ "b": 2 }"#);
    fixture.write("data/c.json", r#"{ "c": 3 }"#);
    fixture.write("data/d.json", r#"{ "d": 4 }"#);
    fixture.write("data/e.json", r#"{ "e": 5 }"#);
    fixture.write("data/f.txt", "f\n");
    fixture.write("unrelated/secret.json", r#"{ "x": 0 }"#);
    fixture.write(
        "src/reader.ts",
        r#"
import fs from "node:fs";
import { statSync, lstatSync, openSync } from "node:fs";
import { join } from "node:path";

const PLAIN_LABELS = ["unrelated"];
export const labels = PLAIN_LABELS.map((l) => l.toUpperCase());

export async function runAll() {
  const a = await fs.promises.readFile(join(import.meta.dirname, "../data/a.json"), "utf8");
  const b = statSync(join(process.cwd(), "data/b.json"));
  const c = lstatSync(new URL("../data/c.json", import.meta.url));
  const d = openSync(`${import.meta.dirname}/../data/d.json`, "r");
  const globs = import.meta.glob(["../data/e.json", "../data/*.txt"]);
  return { a, b, c, d, globs };
}
"#,
    );
    fixture.write(
        "src/cjs-reader.cjs",
        r#"
const fs = require("node:fs");
const path = require("node:path");
module.exports = fs.readFileSync(path.join(__dirname, "../data/a.json"), "utf8");
"#,
    );

    let facts = analyze_workspace(&fixture.root);
    assert!(facts.uncertainties.is_empty(), "{:?}", facts.uncertainties);

    let ts_targets: std::collections::BTreeSet<&str> = facts
        .modules
        .iter()
        .find(|m| m.path == "src/reader.ts")
        .expect("reader.ts")
        .imports
        .iter()
        .filter_map(|imp| imp.resolved_path.as_deref())
        .collect();
    assert_eq!(
        ts_targets,
        std::collections::BTreeSet::from([
            "data/a.json",
            "data/b.json",
            "data/c.json",
            "data/d.json",
            "data/e.json",
            "data/f.txt",
        ]),
        "bare string array PLAIN_LABELS must not pull in unrelated/secret.json"
    );

    let cjs_targets: std::collections::BTreeSet<&str> = facts
        .modules
        .iter()
        .find(|m| m.path == "src/cjs-reader.cjs")
        .expect("cjs-reader.cjs")
        .imports
        .iter()
        .filter_map(|imp| imp.resolved_path.as_deref())
        .collect();
    assert_eq!(
        cjs_targets,
        std::collections::BTreeSet::from(["data/a.json"])
    );
}

fn store_test_manifest() -> &'static str {
    r#"{
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": { "taskIds": ["ui:test", "other:test"] }
        },
        "projects": [
            { "id": "settings", "root": "settings", "fallbackDependencies": [] },
            { "id": "ui", "root": "ui", "fallbackDependencies": [] },
            { "id": "other", "root": "other", "fallbackDependencies": [] }
        ],
        "tasks": [
            {
                "id": "ui:test",
                "project": "ui",
                "kind": "test",
                "execution": {
                    "executable": "node",
                    "args": ["-e", "process.exit(0)"],
                    "fileNarrowing": { "suffixes": [".test.ts"] }
                },
                "dependsOn": [],
                "impact": { "mode": "reachability" }
            },
            {
                "id": "other:test",
                "project": "other",
                "kind": "test",
                "execution": {
                    "executable": "node",
                    "args": ["-e", "process.exit(0)"],
                    "fileNarrowing": { "suffixes": [".test.ts"] }
                },
                "dependsOn": [],
                "impact": { "mode": "reachability" }
            }
        ]
    }"#
}

#[test]
fn store_rebuilds_when_asset_mutates_or_js_adds_new_asset_reference_and_preserves_ts_nodes_on_patch()
 {
    let fixture = StoreFixture::new("store-incremental");
    fixture.write("dads.testing.json", store_test_manifest());
    fixture.write("settings/limit.json", r#"{ "max": 10 }"#);
    fixture.write("settings/new.json", r#"{ "v": 1 }"#);
    fixture.write("ui/widget.ts", "export const widget = 1;\n");
    fixture.write(
        "ui/scan.test.ts",
        r#"
import { readFileSync } from "node:fs";
const limit = readFileSync(new URL("../settings/limit.json", import.meta.url), "utf8");
const widgetSrc = readFileSync(new URL("./widget.ts", import.meta.url), "utf8");
export const combined = limit + widgetSrc;
"#,
    );
    fixture.write("other/unrelated.test.ts", "export const ok = true;\n");
    fixture.init_commit();

    let mut frontend = JavaScriptFrontend;
    let initial = load_or_update(&fixture.request(), &mut frontend);
    assert_eq!(initial.action, SnapshotAction::InitialIndex);

    // 1. Editing scan.test.ts without adding a new asset uses IncrementalUpdate and MUST NOT
    //    overwrite ui/widget.ts's TypeScript node with a synthetic asset node.
    fixture.write(
        "ui/scan.test.ts",
        r#"
import { readFileSync } from "node:fs";
const limit = readFileSync(new URL("../settings/limit.json", import.meta.url), "utf8");
const widgetSrc = readFileSync(new URL("./widget.ts", import.meta.url), "utf8");
export const combined = limit + widgetSrc + "!";
"#,
    );
    let patched = load_or_update(&fixture.request(), &mut frontend);
    assert_eq!(patched.action, SnapshotAction::IncrementalUpdate);
    let patched_graph = patched.graph.expect("patched graph");
    let widget_node = patched_graph
        .materialize_modules()
        .into_iter()
        .find(|m| m.path == "ui/widget.ts")
        .expect("widget.ts node must survive incremental patch");
    assert_eq!(widget_node.language, "typescript");
    assert!(
        widget_node.declarations.iter().any(|d| d.name == "widget"),
        "widget.ts exports must not be clobbered by asset edge patch: {:?}",
        widget_node.declarations
    );

    // 2. Editing scan.test.ts to reference a previously unreferenced asset triggers a full rebuild.
    fixture.write(
        "ui/scan.test.ts",
        r#"
import { readFileSync } from "node:fs";
const limit = readFileSync(new URL("../settings/limit.json", import.meta.url), "utf8");
const extra = readFileSync(new URL("../settings/new.json", import.meta.url), "utf8");
export const combined = limit + extra;
"#,
    );
    let rebuilt_new_asset = load_or_update(&fixture.request(), &mut frontend);
    assert_eq!(rebuilt_new_asset.action, SnapshotAction::Rebuild);
    assert!(
        rebuilt_new_asset
            .graph
            .expect("rebuilt graph")
            .contains_path("settings/new.json")
    );

    // 3. Reverting scan.test.ts and mutating settings/limit.json triggers FullRebuild and reaches ui/scan.test.ts.
    fixture.git(&["checkout", "--", "ui/scan.test.ts"]);
    let _ = load_or_update(&fixture.request(), &mut frontend);
    fixture.write("settings/limit.json", r#"{ "max": 42 }"#);
    let asset_update = load_or_update(&fixture.request(), &mut frontend);
    assert_eq!(asset_update.action, SnapshotAction::Rebuild);
    let response = execute_request_with_graph(fixture.request(), asset_update.graph);
    assert!(response.ok, "plan failed: {:?}", response.error);
    let plan = response.result.expect("result").plan;
    assert!(
        plan.issues.is_empty(),
        "unexpected issues: {:?}",
        plan.issues
    );
    let ui_task = plan
        .tasks
        .iter()
        .find(|t| t.id == "ui:test")
        .expect("ui:test");
    assert_eq!(ui_task.decision, "run");
    assert_eq!(ui_task.selected_files, vec!["ui/scan.test.ts".to_owned()]);
    let other_task = plan
        .tasks
        .iter()
        .find(|t| t.id == "other:test")
        .expect("other:test");
    assert_eq!(other_task.decision, "skip-proven-unaffected");
}
