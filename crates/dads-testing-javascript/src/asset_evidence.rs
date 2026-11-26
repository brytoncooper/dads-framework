//! Synthetic graph nodes and git change evidence for non-JS workspace assets referenced via
//! static asset imports, `fs` reads, or `import.meta.glob`.

use crate::facts::{JsImportKind, JsModuleFacts};
use crate::workspace::git_output;
use dads_testing_core::graph::{ChangedModuleEvidence, ModuleNode, SourceSpan, SymbolFact};
use std::collections::BTreeSet;
use std::path::Path;

pub(crate) const ASSET_EXPORT_SYMBOL: &str = "__asset__";

/// Collects every workspace-relative asset path referenced by `modules` that is not already
/// represented as an analyzed JavaScript/TypeScript module node.
pub(crate) fn referenced_asset_paths(modules: &[JsModuleFacts]) -> BTreeSet<String> {
    let existing: BTreeSet<&str> = modules.iter().map(|module| module.path.as_str()).collect();
    let mut assets = BTreeSet::new();
    for module in modules {
        for import in &module.imports {
            if matches!(import.kind, JsImportKind::Asset | JsImportKind::FileRead)
                && let Some(resolved) = &import.resolved_path
                && !existing.contains(resolved.as_str())
            {
                assets.insert(resolved.clone());
            }
        }
    }
    assets
}

/// Builds a core `ModuleNode` for a non-JS workspace asset so core reachability can seed and walk
/// reverse edges from it without core graph changes.
pub(crate) fn synthetic_asset_node(path: String) -> ModuleNode {
    ModuleNode {
        path,
        language: "asset".to_owned(),
        declarations: vec![SymbolFact {
            name: ASSET_EXPORT_SYMBOL.to_owned(),
            span: SourceSpan { start: 0, end: 0 },
        }],
        references: Vec::new(),
        imports: Vec::new(),
    }
}

/// Emits changed-module evidence for every referenced non-JS asset that is modified relative to
/// `base` (defaulting to `HEAD`) or untracked in the working tree.
pub(crate) fn asset_changed_evidence(
    workspace_root: &Path,
    base: Option<&str>,
    asset_paths: &BTreeSet<String>,
) -> Option<Vec<ChangedModuleEvidence>> {
    if asset_paths.is_empty() {
        return Some(Vec::new());
    }
    let comparison = git_output(
        workspace_root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            base.unwrap_or("HEAD"),
        ],
    )?;
    let comparison = std::str::from_utf8(&comparison).ok()?.trim();
    let changed = read_git_nul_paths(
        workspace_root,
        &[
            "diff",
            "--name-only",
            "--no-renames",
            "-z",
            comparison,
            "--",
        ],
    )?;
    let untracked = read_git_nul_paths(
        workspace_root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?;

    let mut evidence = Vec::new();
    for path in asset_paths {
        if path.ends_with('/') {
            continue;
        }
        let is_changed = if let Some(dir) = path.strip_prefix("fs-dir:") {
            changed.iter().chain(untracked.iter()).any(|p| {
                p == dir
                    || p.strip_prefix(dir)
                        .is_some_and(|rest| rest.starts_with('/'))
            })
        } else {
            changed.contains(path) || untracked.contains(path)
        };
        if is_changed {
            evidence.push(ChangedModuleEvidence {
                path: path.clone(),
                changed_exports: BTreeSet::from([ASSET_EXPORT_SYMBOL.to_owned()]),
                every_hunk_is_attributed: true,
                semantic_change: true,
                type_only_change: false,
                module_eval_changed: false,
                changed_type_exports: None,
            });
        }
    }
    Some(evidence)
}

fn read_git_nul_paths(workspace_root: &Path, arguments: &[&str]) -> Option<BTreeSet<String>> {
    let output = git_output(workspace_root, arguments)?;
    if !output.is_empty() && output.last() != Some(&0) {
        return None;
    }
    output
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8(path.to_vec()).ok())
        .collect()
}
