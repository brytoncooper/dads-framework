use crate::diff_hunks::{
    attributed_exports_for_changed_bytes, changed_content_byte_ranges, changed_hunks,
};
use crate::facts::JsModuleFacts;
use crate::module_analysis::runtime_export_declarations_from_source;
use crate::workspace::git_output;
use dads_testing_core::graph::ChangedModuleEvidence;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

pub(crate) fn changed_module_evidence(
    workspace_root: &Path,
    base: Option<&str>,
    modules: &[JsModuleFacts],
) -> Option<Vec<ChangedModuleEvidence>> {
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
    let changed_paths = git_paths(
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
    let untracked = git_paths(
        workspace_root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?;

    // Old paths absent from the current modules remain uncovered. Core keeps its existing
    // missing-module fallback; the inventory only avoids work for proven unchanged modules.
    let mut changes = Vec::new();
    for module in modules {
        if !changed_paths.contains(&module.path) && !untracked.contains(&module.path) {
            continue;
        }
        let source = fs::read_to_string(workspace_root.join(&module.path)).ok()?;
        if untracked.contains(&module.path) {
            // There is no old-side source proving the complete impact surface of a new module.
            changes.push(ChangedModuleEvidence {
                path: module.path.clone(),
                changed_exports: BTreeSet::new(),
                every_hunk_is_attributed: false,
            });
            continue;
        }
        if let Some(change) = tracked_module_evidence(workspace_root, comparison, module, &source)?
        {
            changes.push(change);
        }
    }
    Some(changes)
}

fn git_paths(workspace_root: &Path, arguments: &[&str]) -> Option<BTreeSet<String>> {
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

fn tracked_module_evidence(
    workspace_root: &Path,
    comparison: &str,
    module: &JsModuleFacts,
    source: &str,
) -> Option<Option<ChangedModuleEvidence>> {
    let output = git_output(
        workspace_root,
        &[
            "--literal-pathspecs",
            "diff",
            "--unified=0",
            "--no-ext-diff",
            comparison,
            "--",
            &module.path,
        ],
    )?;
    let hunks = changed_hunks(&String::from_utf8(output).ok()?)?;
    if hunks.is_empty() {
        return Some(None);
    }
    let baseline_source = if hunks.iter().any(|hunk| hunk.old.count > 0) {
        let baseline_spec = format!("{comparison}:{}", module.path);
        let baseline = git_output(workspace_root, &["show", &baseline_spec])?;
        Some(String::from_utf8(baseline).ok()?)
    } else {
        None
    };
    let baseline_declarations = match baseline_source.as_deref() {
        Some(baseline) => runtime_export_declarations_from_source(
            baseline,
            Path::new(&module.path),
            &module.path,
        )?,
        None => Vec::new(),
    };
    let mut changed_exports = BTreeSet::new();
    let mut every_hunk_is_attributed = true;
    for hunk in hunks {
        let baseline = baseline_source.as_deref().unwrap_or("");
        let (old_changed_bytes, new_changed_bytes) =
            changed_content_byte_ranges(hunk, baseline, source)?;
        for (changed_bytes, declarations, side_source) in [
            (
                old_changed_bytes,
                baseline_declarations.as_slice(),
                baseline,
            ),
            (new_changed_bytes, module.declarations.as_slice(), source),
        ] {
            match attributed_exports_for_changed_bytes(changed_bytes, declarations, side_source) {
                Some(exports) => changed_exports.extend(exports),
                None => every_hunk_is_attributed = false,
            }
        }
    }
    Some(Some(ChangedModuleEvidence {
        path: module.path.clone(),
        changed_exports,
        every_hunk_is_attributed,
    }))
}
