//! Marker-based deterministic `ChaosOp` applier for un-reset chaos timelines and shrink replay.

use crate::fuzz_apply_files::{
    add_failing_test, add_module_and_import, corrupt_one_cache_blob, edit_json_fixture,
    edit_manifest_env, extract_last_i32,
};
use crate::fuzz_graph::{ChaosWorkspaceSpec, relative_import_path};
use crate::fuzz_ops::{ChaosLiveState, ChaosOp, ChaosStep};
use crate::mutations::{git_commit_all, run_git};
use std::fs;
use std::path::Path;

/// Applies all ops in `step` without resetting git. Returns `true` iff this step is a clean
/// pure comment-only precision probe (no prior runtime dirtiness and no runtime/type edits).
pub fn apply_chaos_step(
    ws: &Path,
    cache_dir: &Path,
    spec: &ChaosWorkspaceSpec,
    step: &ChaosStep,
    state: &mut ChaosLiveState,
) -> Result<bool, String> {
    let all_pure_comment = !step.ops.is_empty()
        && step.ops.iter().all(|op| {
            matches!(
                op,
                ChaosOp::CommentOrTypeOnlyEdit {
                    break_type: false,
                    ..
                }
            )
        });
    let is_clean_precision_step = all_pure_comment && !state.runtime_dirty;
    if !all_pure_comment {
        state.runtime_dirty = true;
    }
    for op in &step.ops {
        apply_one_op(ws, cache_dir, spec, op, state)?;
    }
    Ok(is_clean_precision_step)
}

fn apply_one_op(
    ws: &Path,
    cache_dir: &Path,
    spec: &ChaosWorkspaceSpec,
    op: &ChaosOp,
    state: &mut ChaosLiveState,
) -> Result<(), String> {
    match op {
        ChaosOp::EditPureExport { mod_id, delta } => bump_numeric_line(
            ws,
            spec,
            *mod_id,
            "// @pure",
            "export const pureVal: number =",
            *delta,
        ),
        ChaosOp::EditImpureInitializer { mod_id, delta } => {
            edit_impure_init(ws, spec, *mod_id, *delta)
        }
        ChaosOp::EditPrivateHelper { mod_id, delta } => bump_numeric_line(
            ws,
            spec,
            *mod_id,
            "// @helper",
            "const helperVal = (): number =>",
            *delta,
        ),
        ChaosOp::AdjacentCommentAndRuntimeEdit { mod_id, delta } => {
            rewrite_comment_marker(ws, spec, *mod_id, "// @adj-comment:", *delta)?;
            bump_numeric_line(
                ws,
                spec,
                *mod_id,
                "// @pure",
                "export const pureVal: number =",
                *delta,
            )
        }
        ChaosOp::CommentOrTypeOnlyEdit {
            mod_id,
            seq,
            break_type,
        } => {
            if *break_type {
                toggle_type_alias(ws, spec, *mod_id)
            } else {
                let tag = i32::try_from(*seq).unwrap_or(1);
                rewrite_comment_marker(ws, spec, *mod_id, "// @comment:", tag)
            }
        }
        ChaosOp::ToggleSideEffectImport {
            mod_id,
            target_mod,
            add,
        } => toggle_side_effect_import(ws, spec, *mod_id, *target_mod, *add),
        ChaosOp::EditJsonFixture { fixture_idx, delta } => {
            edit_json_fixture(ws, spec, *fixture_idx, *delta)
        }
        ChaosOp::AddNewModuleAndImport {
            project_idx,
            consumer_mod,
            name,
            value,
        } => add_module_and_import(ws, spec, *project_idx, *consumer_mod, name, *value),
        ChaosOp::AddFailingTestFile { project_idx, name } => {
            add_failing_test(ws, spec, *project_idx, name, state)
        }
        ChaosOp::DeleteUnusedOrUsedFile { mod_id } => delete_module_file(ws, spec, *mod_id),
        ChaosOp::StageAndEditWorkingTree {
            mod_id,
            staged_delta,
            working_delta,
        } => stage_and_edit(ws, spec, *mod_id, *staged_delta, *working_delta),
        ChaosOp::GitCommit { message } => {
            let _ = git_commit_all(ws, message)?;
            Ok(())
        }
        ChaosOp::CorruptRandomCacheBlob { pick } => corrupt_one_cache_blob(cache_dir, *pick),
        ChaosOp::EditManifestEnv { project_idx, val } => {
            edit_manifest_env(ws, spec, *project_idx, *val, state)
        }
    }
}

fn delete_module_file(ws: &Path, spec: &ChaosWorkspaceSpec, mod_id: usize) -> Result<(), String> {
    if let Some(m) = spec.modules.get(mod_id) {
        let full = ws.join(&m.rel_path);
        if full.is_file() {
            fs::remove_file(&full).map_err(|e| format!("delete {}: {e}", m.rel_path))?;
        }
    }
    Ok(())
}

fn bump_numeric_line(
    ws: &Path,
    spec: &ChaosWorkspaceSpec,
    mod_id: usize,
    marker: &str,
    prefix: &str,
    delta: i32,
) -> Result<(), String> {
    let Some(m) = spec.modules.get(mod_id) else {
        return Ok(());
    };
    let full = ws.join(&m.rel_path);
    if !full.is_file() {
        return Ok(());
    }
    let content = fs::read_to_string(&full).map_err(|e| format!("read {}: {e}", m.rel_path))?;
    let mut changed = false;
    let updated: Vec<String> = content
        .lines()
        .map(|line| {
            if !changed && line.contains(marker) {
                changed = true;
                let prev = extract_last_i32(line.split(';').next().unwrap_or("")).unwrap_or(1);
                format!("{prefix} {}; {marker}", prev.wrapping_add(delta))
            } else {
                line.to_owned()
            }
        })
        .collect();
    if changed {
        fs::write(&full, format!("{}\n", updated.join("\n")))
            .map_err(|e| format!("write {}: {e}", m.rel_path))?;
    }
    Ok(())
}

fn edit_impure_init(
    ws: &Path,
    spec: &ChaosWorkspaceSpec,
    mod_id: usize,
    delta: i32,
) -> Result<(), String> {
    let Some(m) = spec.modules.get(mod_id) else {
        return Ok(());
    };
    let full = ws.join(&m.rel_path);
    if !full.is_file() {
        return Ok(());
    }
    let content = fs::read_to_string(&full).map_err(|e| format!("read {}: {e}", m.rel_path))?;
    let mut changed = false;
    let updated: Vec<String> = content
        .lines()
        .map(|line| {
            if !changed && line.contains("// @impure") {
                changed = true;
                let prev = extract_last_i32(line.split(';').next().unwrap_or("")).unwrap_or(1);
                format!(
                    "export const impureInit: number = bumpChaos({mod_id}, {}); // @impure",
                    prev.wrapping_add(delta)
                )
            } else {
                line.to_owned()
            }
        })
        .collect();
    if changed {
        fs::write(&full, format!("{}\n", updated.join("\n")))
            .map_err(|e| format!("write {}: {e}", m.rel_path))?;
    }
    Ok(())
}

fn rewrite_comment_marker(
    ws: &Path,
    spec: &ChaosWorkspaceSpec,
    mod_id: usize,
    marker: &str,
    tag: i32,
) -> Result<(), String> {
    let Some(m) = spec.modules.get(mod_id) else {
        return Ok(());
    };
    let full = ws.join(&m.rel_path);
    if !full.is_file() {
        return Ok(());
    }
    let content = fs::read_to_string(&full).map_err(|e| format!("read {}: {e}", m.rel_path))?;
    let mut changed = false;
    let updated: Vec<String> = content
        .lines()
        .map(|line| {
            if !changed && line.starts_with(marker) {
                changed = true;
                let prev = extract_last_i32(line).unwrap_or(0);
                format!("{marker} {}", prev.wrapping_add(tag.max(1)))
            } else {
                line.to_owned()
            }
        })
        .collect();
    if changed {
        fs::write(&full, format!("{}\n", updated.join("\n")))
            .map_err(|e| format!("write {}: {e}", m.rel_path))?;
    }
    Ok(())
}

fn toggle_type_alias(ws: &Path, spec: &ChaosWorkspaceSpec, mod_id: usize) -> Result<(), String> {
    let Some(m) = spec.modules.get(mod_id) else {
        return Ok(());
    };
    let full = ws.join(&m.rel_path);
    if !full.is_file() {
        return Ok(());
    }
    let content = fs::read_to_string(&full).map_err(|e| format!("read {}: {e}", m.rel_path))?;
    let updated = if content.contains("export type ModTag = number; // @type") {
        content.replacen(
            "export type ModTag = number; // @type",
            "export type ModTag = string; // @type",
            1,
        )
    } else if content.contains("export type ModTag = string; // @type") {
        content.replacen(
            "export type ModTag = string; // @type",
            "export type ModTag = number; // @type",
            1,
        )
    } else {
        return Ok(());
    };
    fs::write(&full, updated).map_err(|e| format!("write {}: {e}", m.rel_path))
}

fn toggle_side_effect_import(
    ws: &Path,
    spec: &ChaosWorkspaceSpec,
    mod_id: usize,
    target_mod: usize,
    add: bool,
) -> Result<(), String> {
    if mod_id == target_mod {
        return Ok(());
    }
    let (Some(m), Some(target)) = (spec.modules.get(mod_id), spec.modules.get(target_mod)) else {
        return Ok(());
    };
    let full = ws.join(&m.rel_path);
    if !full.is_file() || !ws.join(&target.rel_path).is_file() {
        return Ok(());
    }
    let content = fs::read_to_string(&full).map_err(|e| format!("read {}: {e}", m.rel_path))?;
    let marker = format!("// @se-{target_mod}");
    if add {
        if content.contains(&marker) || !content.contains("// @se-insert") {
            return Ok(());
        }
        let rel = relative_import_path(&m.rel_path, &target.rel_path);
        let updated = content.replacen(
            "// @se-insert",
            &format!("import \"{rel}\"; {marker}\n// @se-insert"),
            1,
        );
        fs::write(&full, updated).map_err(|e| format!("write {}: {e}", m.rel_path))
    } else if content.contains(&marker) {
        let kept: Vec<&str> = content.lines().filter(|l| !l.contains(&marker)).collect();
        fs::write(&full, format!("{}\n", kept.join("\n")))
            .map_err(|e| format!("write {}: {e}", m.rel_path))
    } else {
        Ok(())
    }
}

fn stage_and_edit(
    ws: &Path,
    spec: &ChaosWorkspaceSpec,
    mod_id: usize,
    staged_delta: i32,
    working_delta: i32,
) -> Result<(), String> {
    let Some(m) = spec.modules.get(mod_id) else {
        return Ok(());
    };
    if !ws.join(&m.rel_path).is_file() {
        return Ok(());
    }
    bump_numeric_line(
        ws,
        spec,
        mod_id,
        "// @pure",
        "export const pureVal: number =",
        staged_delta,
    )?;
    let _ = run_git(ws, &["add", &m.rel_path])?;
    bump_numeric_line(
        ws,
        spec,
        mod_id,
        "// @pure",
        "export const pureVal: number =",
        working_delta,
    )
}
