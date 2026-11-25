#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct BoundaryWorkspace {
    root: PathBuf,
}

impl BoundaryWorkspace {
    fn new(label: &str) -> Self {
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

    fn write(&self, rel: &str, content: &str) {
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

    fn init_git_and_commit(&self, message: &str) {
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

    fn check_boundaries(
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

fn setup_standard_workspace(ws: &BoundaryWorkspace, boundaries: Value) {
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

#[test]
fn allowed_imports_produce_zero_violations() {
    let ws = BoundaryWorkspace::new("allowed");
    setup_standard_workspace(
        &ws,
        json!({
            "depConstraints": [
                {
                    "sourceTag": "env:browser",
                    "onlyDependOnLibsWithTags": ["env:browser", "shared"],
                    "notDependOnLibsWithTags": ["env:server"],
                    "bannedExternalImports": ["pg"],
                    "allowedExternalImports": ["zod", "react*"]
                }
            ]
        }),
    );
    ws.write("libs/shared/src/index.ts", "export const shared = 1;\n");
    ws.write("libs/ui/src/helper.ts", "export const h = 2;\n");
    ws.write(
        "libs/ui/src/index.ts",
        r#"
import { shared } from "@ws/shared";
import { h } from "./helper";
import { z } from "zod";
import { useState } from "react";
import { readFileSync } from "node:fs";
import path from "path";
export const ok = [shared, h, z, useState, readFileSync, path];
"#,
    );
    ws.init_git_and_commit("baseline");

    let resp = ws.check_boundaries(None, None, None);
    assert_eq!(resp["ok"], true, "{resp}");
    let violations = resp["result"]["boundaries"]["violations"]
        .as_array()
        .expect("violations array");
    assert!(violations.is_empty(), "expected no violations: {violations:?}");
    assert!(resp["result"]["boundaries"]["checkedFiles"].as_u64().unwrap() >= 3);
}

#[test]
fn reports_tag_constraints_banned_and_allowed_externals_cycles_relative_buildable_and_nested() {
    let ws = BoundaryWorkspace::new("violations");
    setup_standard_workspace(
        &ws,
        json!({
            "enforceBuildableLibDependency": true,
            "checkNestedImports": true,
            "allow": ["@ws/allowed-special", "legacy-*"],
            "depConstraints": [
                {
                    "sourceTag": "env:browser",
                    "onlyDependOnLibsWithTags": ["env:browser", "shared"],
                    "notDependOnLibsWithTags": ["env:server"],
                    "bannedExternalImports": ["pg", "node-pg-*"],
                    "allowedExternalImports": ["zod"]
                }
            ]
        }),
    );
    ws.write("libs/shared/src/index.ts", "export const s = 1;\n");
    ws.write("libs/non-buildable/src/index.ts", "export const nb = 1;\n");
    // Reverse edge server -> ui so ui -> server triggers circular-dependency.
    ws.write(
        "libs/server/src/index.ts",
        "import { ok } from \"@ws/ui\";\nexport const srv = ok;\n",
    );
    ws.write("libs/server/src/internal.ts", "export const secret = 42;\n");
    ws.write(
        "libs/ui/src/index.ts",
        r#"
import { srv } from "@ws/server";
import { secret } from "@ws/server/internal";
import { srv as relSrv } from "../../server/src/index";
import pg from "pg";
import migrate from "node-pg-migrate";
import lodash from "lodash";
import special from "@ws/allowed-special";
import legacy from "legacy-pkg";
import { z } from "zod";
export const ok = [srv, secret, relSrv, pg, migrate, lodash, special, legacy, z];
"#,
    );
    ws.write(
        "libs/buildable/src/index.ts",
        "import { nb } from \"@ws/non-buildable\";\nexport const b = nb;\n",
    );
    ws.init_git_and_commit("baseline");

    let resp = ws.check_boundaries(None, None, None);
    assert_eq!(resp["ok"], true, "{resp}");
    let violations = resp["result"]["boundaries"]["violations"]
        .as_array()
        .expect("violations array");

    let has_rule = |file_suffix: &str, specifier: &str, rule: &str| {
        violations.iter().any(|v| {
            v["file"].as_str().is_some_and(|f| f.ends_with(file_suffix))
                && v["specifier"].as_str() == Some(specifier)
                && v["rule"].as_str() == Some(rule)
                && v["line"].as_u64().unwrap_or(0) >= 1
                && v["column"].as_u64().unwrap_or(0) >= 1
        })
    };

    assert!(has_rule("libs/ui/src/index.ts", "@ws/server", "only-depend-on-libs-with-tags"), "{violations:?}");
    assert!(has_rule("libs/ui/src/index.ts", "@ws/server", "not-depend-on-libs-with-tags"), "{violations:?}");
    assert!(has_rule("libs/ui/src/index.ts", "@ws/server", "circular-dependency"), "{violations:?}");
    assert!(has_rule("libs/ui/src/index.ts", "@ws/server/internal", "nested-import"), "{violations:?}");
    assert!(has_rule("libs/ui/src/index.ts", "../../server/src/index", "no-relative-cross-project"), "{violations:?}");
    assert!(has_rule("libs/ui/src/index.ts", "pg", "banned-external-import"), "{violations:?}");
    assert!(has_rule("libs/ui/src/index.ts", "node-pg-migrate", "banned-external-import"), "{violations:?}");
    assert!(has_rule("libs/ui/src/index.ts", "lodash", "allowed-external-import"), "{violations:?}");
    assert!(has_rule("libs/buildable/src/index.ts", "@ws/non-buildable", "buildable-lib-dependency"), "{violations:?}");

    // `allow` exemptions and allowed `zod` must NOT be reported.
    assert!(!violations.iter().any(|v| v["specifier"] == "@ws/allowed-special"), "{violations:?}");
    assert!(!violations.iter().any(|v| v["specifier"] == "legacy-pkg"), "{violations:?}");
    assert!(!violations.iter().any(|v| v["specifier"] == "zod"), "{violations:?}");
}

#[test]
fn circular_self_dependency_is_enforced_by_default_and_respects_allow_flag() {
    let ws = BoundaryWorkspace::new("self-dep");
    setup_standard_workspace(&ws, json!({ "allowCircularSelfDependency": false }));
    ws.write("libs/ui/src/index.ts", "export const x = 1;\n");
    ws.write(
        "libs/ui/src/consumer.ts",
        "import { x } from \"@ws/ui\";\nexport const y = x;\n",
    );
    ws.init_git_and_commit("baseline");

    let resp = ws.check_boundaries(None, None, None);
    assert_eq!(resp["ok"], true, "{resp}");
    let violations = resp["result"]["boundaries"]["violations"]
        .as_array()
        .expect("violations");
    assert_eq!(violations.len(), 1, "{violations:?}");
    assert_eq!(violations[0]["rule"], "circular-self-dependency");
    assert_eq!(violations[0]["sourceProject"], "ui");
    assert_eq!(violations[0]["targetProject"], "ui");
    assert_eq!(violations[0]["specifier"], "@ws/ui");

    // Now enable allowCircularSelfDependency via --config override.
    ws.write(
        "boundaries-allow-self.json",
        r#"{ "allowCircularSelfDependency": true }"#,
    );
    let resp_allowed = ws.check_boundaries(None, None, Some("boundaries-allow-self.json"));
    assert_eq!(resp_allowed["ok"], true, "{resp_allowed}");
    assert!(
        resp_allowed["result"]["boundaries"]["violations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn base_ref_filters_checks_to_changed_files_only() {
    let ws = BoundaryWorkspace::new("base-filter");
    setup_standard_workspace(
        &ws,
        json!({
            "depConstraints": [
                {
                    "sourceTag": "env:browser",
                    "notDependOnLibsWithTags": ["env:server"]
                }
            ]
        }),
    );
    ws.write("libs/server/src/index.ts", "export const s = 1;\n");
    // Pre-existing violation in untouched file:
    ws.write(
        "libs/ui/src/legacy.ts",
        "import { s } from \"@ws/server\";\nexport const legacy = s;\n",
    );
    ws.write("libs/ui/src/clean.ts", "export const clean = 1;\n");
    ws.init_git_and_commit("baseline");

    // Edit only libs/ui/src/clean.ts (stays clean).
    ws.write("libs/ui/src/clean.ts", "export const clean = 2;\n");

    let resp = ws.check_boundaries(Some("HEAD"), None, None);
    assert_eq!(resp["ok"], true, "{resp}");
    let violations = resp["result"]["boundaries"]["violations"]
        .as_array()
        .unwrap();
    assert!(
        violations.is_empty(),
        "untouched legacy.ts violation must be filtered out by --base HEAD: {violations:?}"
    );
    assert_eq!(resp["result"]["boundaries"]["checkedFiles"], 1);

    // Now introduce a violation in clean.ts and verify it IS caught.
    ws.write(
        "libs/ui/src/clean.ts",
        "import { s } from \"@ws/server\";\nexport const clean = s;\n",
    );
    let resp2 = ws.check_boundaries(Some("HEAD"), None, None);
    assert_eq!(resp2["ok"], true, "{resp2}");
    let violations2 = resp2["result"]["boundaries"]["violations"]
        .as_array()
        .unwrap();
    assert_eq!(violations2.len(), 1, "{violations2:?}");
    assert_eq!(violations2[0]["file"], "libs/ui/src/clean.ts");
    assert_eq!(violations2[0]["rule"], "not-depend-on-libs-with-tags");
}

#[test]
fn standalone_config_works_without_dads_testing_json() {
    let ws = BoundaryWorkspace::new("no-manifest");
    ws.write(
        "tsconfig.base.json",
        r#"{ "compilerOptions": { "paths": { "@ws/a": ["libs/a/src/index.ts"], "@ws/b": ["libs/b/src/index.ts"] } } }"#,
    );
    ws.write("libs/a/project.json", r#"{ "name": "a", "tags": ["scope:a"] }"#);
    ws.write("libs/b/project.json", r#"{ "name": "b", "tags": ["scope:b"] }"#);
    ws.write("libs/b/src/index.ts", "export const b = 1;\n");
    ws.write(
        "libs/a/src/index.ts",
        "import { b } from \"@ws/b\";\nexport const a = b;\n",
    );
    ws.write(
        "boundaries.json",
        r#"{ "depConstraints": [{ "sourceTag": "scope:a", "notDependOnLibsWithTags": ["scope:b"] }] }"#,
    );
    assert!(!Path::new(&ws.root.join("dads.testing.json")).exists());

    let resp = ws.check_boundaries(None, None, Some("boundaries.json"));
    assert_eq!(resp["ok"], true, "{resp}");
    let violations = resp["result"]["boundaries"]["violations"]
        .as_array()
        .unwrap();
    assert_eq!(violations.len(), 1, "{violations:?}");
    assert_eq!(violations[0]["sourceProject"], "a");
    assert_eq!(violations[0]["targetProject"], "b");
    assert_eq!(violations[0]["rule"], "not-depend-on-libs-with-tags");
}

#[test]
fn refuses_when_no_boundaries_config_is_present() {
    let ws = BoundaryWorkspace::new("missing-config");
    ws.write("libs/a/src/index.ts", "export const a = 1;\n");

    let resp = ws.check_boundaries(None, None, None);
    assert_eq!(resp["ok"], false, "{resp}");
    assert!(
        resp["error"]
            .as_str()
            .is_some_and(|e| e.contains("No boundaries configuration found")),
        "{resp}"
    );
}

#[test]
fn ban_transitive_dependencies_checks_enclosing_and_root_package_jsons() {
    let ws = BoundaryWorkspace::new("ban-transitive");
    setup_standard_workspace(
        &ws,
        json!({
            "banTransitiveDependencies": true,
            "allow": ["exempt-pkg", "exempt-prefix-*"]
        }),
    );
    ws.write(
        "package.json",
        &json!({
            "name": "root-ws",
            "dependencies": { "zod": "^3.0.0" },
            "devDependencies": { "@acme/root-dev": "^1.0.0" }
        })
        .to_string(),
    );
    ws.write(
        "libs/ui/package.json",
        &json!({
            "name": "@ws/ui",
            "peerDependencies": { "react": "^19.0.0" },
            "optionalDependencies": { "fsevents": "^2.3.0" }
        })
        .to_string(),
    );
    ws.write("libs/shared/src/index.ts", "export const shared = 1;\n");
    ws.write(
        "libs/ui/src/nested/index.ts",
        r#"
import ms from "ms";
import sub from "@scope/undeclared/subpath";
import { z } from "zod/v4";
import { devHelper } from "@acme/root-dev/helper";
import { useState } from "react";
import fsevents from "fsevents";
import { readFileSync } from "node:fs";
import fs from "fs";
import exempt from "exempt-pkg";
import exemptPref from "exempt-prefix-one";
import { shared } from "@ws/shared";
export const all = [ms, sub, z, devHelper, useState, fsevents, readFileSync, fs, exempt, exemptPref, shared];
"#,
    );
    ws.init_git_and_commit("baseline");

    let resp = ws.check_boundaries(None, None, None);
    assert_eq!(resp["ok"], true, "{resp}");
    let violations = resp["result"]["boundaries"]["violations"]
        .as_array()
        .expect("violations array");
    assert_eq!(violations.len(), 2, "expected only ms and @scope/undeclared: {violations:?}");
    assert_eq!(violations[0]["rule"], "ban-transitive-dependency");
    assert_eq!(violations[0]["specifier"], "ms");
    assert!(
        violations[0]["message"]
            .as_str()
            .is_some_and(|m| m.contains("\"ms\"")),
        "{violations:?}"
    );
    assert_eq!(violations[1]["rule"], "ban-transitive-dependency");
    assert_eq!(violations[1]["specifier"], "@scope/undeclared/subpath");
    assert!(
        violations[1]["message"]
            .as_str()
            .is_some_and(|m| m.contains("\"@scope/undeclared\"")),
        "{violations:?}"
    );
}

#[test]
fn ignore_paths_and_exclude_projects_skip_origin_files_while_keeping_cycle_graph() {
    let ws = BoundaryWorkspace::new("ignore-and-exclude");
    setup_standard_workspace(
        &ws,
        json!({
            "ignorePaths": [
                "libs/ui/src/ignored-exact.ts",
                "libs/ui/src/generated/**",
                "libs/ui/scripts",
                "**/*.mjs"
            ],
            "excludeProjects": ["server"],
            "depConstraints": [
                {
                    "sourceTag": "env:browser",
                    "bannedExternalImports": ["pg"]
                },
                {
                    "sourceTag": "env:server",
                    "bannedExternalImports": ["pg"]
                }
            ]
        }),
    );
    // server is excluded from checking, so its banned `pg` import produces no violation,
    // yet its `@ws/ui` edge remains in the project graph so `ui -> server` still detects a cycle.
    ws.write(
        "libs/server/src/index.ts",
        "import pg from \"pg\";\nimport { ok } from \"@ws/ui\";\nexport const srv = [pg, ok];\n",
    );
    // Ignored via exact file match:
    ws.write(
        "libs/ui/src/ignored-exact.ts",
        "import pg from \"pg\";\nexport const a = pg;\n",
    );
    // Ignored via `libs/ui/src/generated/**` glob:
    ws.write(
        "libs/ui/src/generated/sub/file.ts",
        "import pg from \"pg\";\nexport const b = pg;\n",
    );
    // Ignored via directory prefix `libs/ui/scripts`:
    ws.write(
        "libs/ui/scripts/seed.ts",
        "import pg from \"pg\";\nexport const c = pg;\n",
    );
    // Ignored via `**/*.mjs` glob:
    ws.write(
        "libs/ui/src/config.mjs",
        "import pg from \"pg\";\nexport const d = pg;\n",
    );
    // Non-ignored file in ui: triggers both `banned-external-import` and `circular-dependency`.
    ws.write(
        "libs/ui/src/index.ts",
        "import pg from \"pg\";\nimport { srv } from \"@ws/server\";\nexport const ok = [pg, srv];\n",
    );
    ws.init_git_and_commit("baseline");

    let resp = ws.check_boundaries(None, None, None);
    assert_eq!(resp["ok"], true, "{resp}");
    let violations = resp["result"]["boundaries"]["violations"]
        .as_array()
        .expect("violations array");
    assert_eq!(resp["result"]["boundaries"]["checkedFiles"], 1, "{resp}");
    assert_eq!(violations.len(), 2, "{violations:?}");
    assert!(
        violations.iter().all(|v| v["file"] == "libs/ui/src/index.ts"),
        "only libs/ui/src/index.ts should be checked: {violations:?}"
    );
    assert!(
        violations.iter().any(|v| v["rule"] == "banned-external-import" && v["specifier"] == "pg"),
        "{violations:?}"
    );
    assert!(
        violations.iter().any(|v| v["rule"] == "circular-dependency" && v["specifier"] == "@ws/server"),
        "{violations:?}"
    );
}
