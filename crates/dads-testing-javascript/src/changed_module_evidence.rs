use crate::diff_hunks::{
    ByteRange, attributed_exports_for_changed_bytes, changed_content_byte_ranges, changed_hunks,
    is_comment_only_range,
};
use crate::erased_spans::comment_and_type_only_spans_from_source;
use crate::facts::JsModuleFacts;
use crate::intra_file_deps::expand_same_file_changed_exports;
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
                semantic_change: true,
                type_only_change: false,
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
        Some(load_baseline_source(
            workspace_root,
            comparison,
            &module.path,
        )?)
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
    let baseline_erased = baseline_source.as_deref().and_then(|baseline| {
        comment_and_type_only_spans_from_source(baseline, Path::new(&module.path))
    });
    let current_erased = comment_and_type_only_spans_from_source(source, Path::new(&module.path));
    let mut changed_exports = BTreeSet::new();
    let mut every_hunk_is_attributed = true;
    let can_check_erased =
        current_erased.is_some() && (baseline_source.is_none() || baseline_erased.is_some());
    let mut all_hunks_comment_only = can_check_erased;
    let mut all_hunks_type_or_comment = can_check_erased;
    for hunk in hunks {
        let baseline = baseline_source.as_deref().unwrap_or("");
        let (old_changed_bytes, new_changed_bytes) =
            changed_content_byte_ranges(hunk, baseline, source)?;
        if all_hunks_comment_only
            && !hunk_covered_by_spans(
                old_changed_bytes,
                new_changed_bytes,
                baseline,
                source,
                baseline_erased.as_ref().map(|(s, _)| s.as_slice()),
                current_erased.as_ref().map(|(s, _)| s.as_slice()),
            )
        {
            all_hunks_comment_only = false;
        }
        let hunk_is_erased = can_check_erased
            && hunk_covered_by_spans(
                old_changed_bytes,
                new_changed_bytes,
                baseline,
                source,
                baseline_erased.as_ref().map(|(_, s)| s.as_slice()),
                current_erased.as_ref().map(|(_, s)| s.as_slice()),
            );
        if !hunk_is_erased {
            all_hunks_type_or_comment = false;
            attribute_hunk_sides(
                (
                    old_changed_bytes,
                    baseline_declarations.as_slice(),
                    baseline,
                ),
                (new_changed_bytes, module.declarations.as_slice(), source),
                &mut changed_exports,
                &mut every_hunk_is_attributed,
            );
        }
    }
    if all_hunks_comment_only {
        return Some(Some(plain_evidence(&module.path, false, false)));
    }
    if all_hunks_type_or_comment {
        return Some(Some(plain_evidence(&module.path, true, true)));
    }
    if every_hunk_is_attributed && !changed_exports.is_empty() {
        changed_exports = close_same_file_exports(source, module, &changed_exports);
    }
    let zero_export_module = module.declarations.is_empty() && baseline_declarations.is_empty();
    Some(Some(ChangedModuleEvidence {
        path: module.path.clone(),
        changed_exports,
        every_hunk_is_attributed: every_hunk_is_attributed || zero_export_module,
        semantic_change: true,
        type_only_change: false,
    }))
}

fn attribute_hunk_sides(
    old_side: (ByteRange, &[crate::facts::JsSymbolFact], &str),
    new_side: (ByteRange, &[crate::facts::JsSymbolFact], &str),
    changed_exports: &mut BTreeSet<String>,
    every_hunk_is_attributed: &mut bool,
) {
    for (changed_bytes, declarations, side_source) in [old_side, new_side] {
        match attributed_exports_for_changed_bytes(changed_bytes, declarations, side_source) {
            Some(exports) => changed_exports.extend(exports),
            None => *every_hunk_is_attributed = false,
        }
    }
}

fn close_same_file_exports(
    source: &str,
    module: &JsModuleFacts,
    direct: &BTreeSet<String>,
) -> BTreeSet<String> {
    if let Some(expanded) =
        expand_same_file_changed_exports(source, Path::new(&module.path), direct)
    {
        return expanded;
    }
    let mut conservative = direct.clone();
    conservative.extend(module.declarations.iter().map(|decl| decl.name.clone()));
    conservative
}

fn load_baseline_source(workspace_root: &Path, comparison: &str, path: &str) -> Option<String> {
    let baseline_spec = format!("{comparison}:{path}");
    let baseline = git_output(workspace_root, &["show", &baseline_spec])?;
    String::from_utf8(baseline).ok()
}

fn plain_evidence(
    path: &str,
    semantic_change: bool,
    type_only_change: bool,
) -> ChangedModuleEvidence {
    ChangedModuleEvidence {
        path: path.to_owned(),
        changed_exports: BTreeSet::new(),
        every_hunk_is_attributed: true,
        semantic_change,
        type_only_change,
    }
}

fn hunk_covered_by_spans(
    old_changed_bytes: ByteRange,
    new_changed_bytes: ByteRange,
    baseline: &str,
    source: &str,
    baseline_spans: Option<&[crate::facts::JsSpan]>,
    current_spans: Option<&[crate::facts::JsSpan]>,
) -> bool {
    let old_ok = baseline_spans.map_or(old_changed_bytes.is_empty(), |spans| {
        is_comment_only_range(old_changed_bytes, spans, baseline)
    });
    let new_ok =
        current_spans.is_some_and(|spans| is_comment_only_range(new_changed_bytes, spans, source));
    old_ok && new_ok
}
