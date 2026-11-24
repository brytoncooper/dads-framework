use crate::analyze_workspace;
use crate::facts::JsUncertainty;
use dads_testing_core::{NativeRequest, Operation};
use std::fs::{create_dir_all, remove_dir_all, write};
use std::process::Command;

pub(super) fn located_uncertainty(root: &std::path::Path, code: &str) -> JsUncertainty {
    let facts = analyze_workspace(root);
    let uncertainty = facts
        .uncertainties
        .iter()
        .find(|uncertainty| uncertainty.code == code)
        .unwrap_or_else(|| panic!("{code} must be reported: {:?}", facts.uncertainties))
        .clone();
    assert!(
        uncertainty.span.is_some(),
        "{code} must carry the syntax that caused it"
    );
    uncertainty
}

pub(super) fn request(root: &std::path::Path) -> NativeRequest {
    NativeRequest {
        schema_version: 1,
        operation: Operation::Plan,
        workspace_root: root.display().to_string(),
        manifest_path: None,
        base: None,
        head: None,
        all: false,
        task_ids: Vec::new(),
        task_kinds: Vec::new(),
        shard: None,
        jobs: None,
        cache: false,
        remote_cache_url: None,
    }
}

pub(super) fn git(root: &std::path::Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(root)
        .status()
        .expect("git must start");
    assert!(status.success(), "git {} must succeed", args.join(" "));
}

pub(super) fn symbol_fixture(name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(name);
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(
        root.join("src/a.ts"),
        "import { a } from './leaf'; export const usesA = a;\n",
    )
    .expect("fixture A importer must be written");
    write(
        root.join("src/b.ts"),
        "import { b } from './leaf'; export const usesB = b;\n",
    )
    .expect("fixture B importer must be written");
    root
}

pub(super) fn commit_fixture(root: &std::path::Path) {
    git(root, &["init"]);
    git(root, &["config", "user.email", "testing@example.com"]);
    git(root, &["config", "user.name", "Dads Testing"]);
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "initial"]);
}
