//! Deterministic mutation dispatcher + git/cache fault-injection helpers for 93-family DST.

use crate::model::{MutationKind, WorkspaceShape};
use crate::mutations_advanced::{AdvancedMutationPaths, apply_advanced_mutation};
use crate::mutations_lang_edge::apply_section_c_mutation;
use crate::mutations_lifecycle::apply_section_d_mutation;
use crate::mutations_section_a::{apply_section_a_mutation, is_section_a_mutation};
use crate::mutations_subsystems::apply_section_b_mutation;
use crate::node_oracle::OracleTestSpec;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpecialTimeline {
    BoundariesCheck,
    RemoteCacheFault,
    ConcurrentCacheWriters,
    CliFiltersShardStalePlan,
}

#[derive(Debug, Default)]
pub struct AppliedMutation {
    pub force_commit: bool,
    pub force_untracked: bool,
    pub force_plan_file: bool,
    pub corrupt_shared_cache: bool,
    pub chained_dirty_steps: bool,
    pub multi_branch_l2_cache: bool,
    pub rebuild_dep_for_oracle: bool,
    pub sharded_plan_union: bool,
    pub verify_unrelated_passes: bool,
    pub oracle_env_override: Option<(String, String, String)>,
    pub dad_process_env: Vec<(String, String)>,
    pub force_only_tasks: Vec<String>,
    pub extra_oracle_tests: Vec<(String, OracleTestSpec)>,
    pub deleted_test_files: Vec<String>,
    pub expected_skipped_tasks: Vec<String>,
    pub special_timeline: Option<SpecialTimeline>,
    pub git_head_override: Option<String>,
    pub worktree_override_dir: Option<PathBuf>,
}

pub fn apply_mutation(
    paths: &AdvancedMutationPaths<'_>,
    shape: &WorkspaceShape,
    kind: MutationKind,
    step_idx: usize,
) -> Result<AppliedMutation, String> {
    match kind {
        MutationKind::PureExportValue
        | MutationKind::UnusedPureExport
        | MutationKind::PrivateHelperUsedByExport
        | MutationKind::ImpureExportInitializerAssign
        | MutationKind::ImpureExportInitializerCall
        | MutationKind::HelperCalledByImpureInitializer
        | MutationKind::ClassStaticBlockSideEffect
        | MutationKind::TopLevelStatementSideEffect
        | MutationKind::MixedExportAndUnusedRuntimeImport
        | MutationKind::CommentOrTypeOnlyEdit => {
            apply_core_code_mutation(paths.workspace_dir, kind, step_idx)
        }
        MutationKind::StaticJsonImport
        | MutationKind::FsReadFileSyncNewUrl
        | MutationKind::FsReaddirSyncExistingFile
        | MutationKind::FsReaddirSyncAddedFile
        | MutationKind::SetupFileMutation
        | MutationKind::TsconfigAliasRetarget
        | MutationKind::ImpactPathsWithWarmCache
        | MutationKind::UpstreamLibWithWarmCacheAndPlanFile
        | MutationKind::UncertainUpstreamWithEmptyFallback
        | MutationKind::CorruptSharedCacheBlob => {
            apply_core_env_or_asset_mutation(paths.workspace_dir, shape, kind, step_idx)
        }
        _ if is_section_a_mutation(kind) => {
            apply_section_a_mutation(paths.workspace_dir, kind, step_idx)
        }
        _ if kind.is_section_b() => {
            apply_section_b_mutation(paths.workspace_dir, shape, kind, step_idx)
        }
        _ if kind.is_section_c() => {
            apply_section_c_mutation(paths.workspace_dir, shape, kind, step_idx)
        }
        _ if kind.is_section_d() => apply_section_d_mutation(paths, shape, kind, step_idx),
        _ => apply_advanced_mutation(paths, shape, kind, step_idx),
    }
}

fn apply_core_code_mutation(
    root: &Path,
    kind: MutationKind,
    step_idx: usize,
) -> Result<AppliedMutation, String> {
    match kind {
        MutationKind::PureExportValue => replace_once(
            root,
            "core/math.ts",
            "n * baseScale()",
            "n * baseScale() + 10",
        )?,
        MutationKind::UnusedPureExport => replace_once(
            root,
            "billing/pure.ts",
            "export const unusedPureExport = 7;",
            &format!("export const unusedPureExport = {};", 100 + step_idx),
        )?,
        MutationKind::PrivateHelperUsedByExport => {
            replace_once(root, "core/math.ts", "=> 2;", "=> 5;")?;
        }
        MutationKind::ImpureExportInitializerAssign => replace_once(
            root,
            "billing/tax.ts",
            "export const assignMarker = (shared.assign = 2);",
            "export const assignMarker = (shared.assign = 5);",
        )?,
        MutationKind::ImpureExportInitializerCall => replace_once(
            root,
            "billing/tax.ts",
            "export const callMarker = setRate(2);",
            "export const callMarker = setRate(5);",
        )?,
        MutationKind::HelperCalledByImpureInitializer => replace_once(
            root,
            "billing/tax.ts",
            "shared.call = n;",
            "shared.call = n + 3;",
        )?,
        MutationKind::ClassStaticBlockSideEffect => replace_once(
            root,
            "billing/tax.ts",
            "shared.staticBlock = 2;",
            "shared.staticBlock = 5;",
        )?,
        MutationKind::TopLevelStatementSideEffect => {
            replace_once(
                root,
                "billing/tax.ts",
                "// top-stmt-slot",
                "shared.topStmt = 5;",
            )?;
        }
        MutationKind::MixedExportAndUnusedRuntimeImport => {
            let path = root.join("billing/tax.ts");
            let current = fs::read_to_string(&path).map_err(|e| format!("read tax.ts: {e}"))?;
            let with_import =
                format!("import {{ sideEffectInit }} from \"./side-effect.ts\";\n{current}");
            let updated = with_import.replacen(
                "export const unusedBilling = 42;",
                "export const unusedBilling = 43;",
                1,
            );
            fs::write(&path, updated).map_err(|e| format!("write tax.ts: {e}"))?;
        }
        MutationKind::CommentOrTypeOnlyEdit => replace_once(
            root,
            "core/math.ts",
            "// core math module",
            &format!("// core math module comment {step_idx}"),
        )?,
        _ => {}
    }
    Ok(AppliedMutation::default())
}

fn apply_core_env_or_asset_mutation(
    root: &Path,
    shape: &WorkspaceShape,
    kind: MutationKind,
    step_idx: usize,
) -> Result<AppliedMutation, String> {
    let mut outcome = AppliedMutation::default();
    match kind {
        MutationKind::StaticJsonImport => {
            fs::write(root.join("settings/limit.json"), "{\"limit\": 9}\n")
                .map_err(|e| format!("write limit.json: {e}"))?;
        }
        MutationKind::FsReadFileSyncNewUrl => {
            fs::write(root.join("settings/disk-limit.json"), "{\"limit\": 9}\n")
                .map_err(|e| format!("write disk-limit.json: {e}"))?;
        }
        MutationKind::FsReaddirSyncExistingFile => {
            fs::write(root.join("settings/rules/rule-a.txt"), "FORBIDDEN\n")
                .map_err(|e| format!("write rule-a.txt: {e}"))?;
        }
        MutationKind::FsReaddirSyncAddedFile => {
            fs::write(
                root.join(format!("settings/rules/rule-added-{step_idx}.txt")),
                "FORBIDDEN\n",
            )
            .map_err(|e| format!("write added rule: {e}"))?;
        }
        MutationKind::SetupFileMutation => {
            if shape.use_setup_file {
                replace_once(
                    root,
                    "ui/setup-helper.ts",
                    "=> CORE_SETUP_TAG;",
                    "=> \"broken\";",
                )?;
            } else {
                replace_once(root, "core/math.ts", "=> 2;", "=> 6;")?;
            }
        }
        MutationKind::TsconfigAliasRetarget => {
            if shape.use_tsconfig_aliases {
                replace_once(
                    root,
                    "tsconfig.base.json",
                    "\"core/math.ts\"",
                    "\"core/alt.ts\"",
                )?;
            } else {
                replace_once(root, "core/math.ts", "n * baseScale()", "n * 99")?;
            }
        }
        MutationKind::ImpactPathsWithWarmCache => {
            fs::write(
                root.join("settings/impact-flag.json"),
                "{\"flag\": \"broken\"}\n",
            )
            .map_err(|e| format!("write impact-flag.json: {e}"))?;
            outcome.force_commit = true;
        }
        MutationKind::UpstreamLibWithWarmCacheAndPlanFile => {
            replace_once(
                root,
                "core/math.ts",
                "n * baseScale()",
                "n * baseScale() + 7",
            )?;
            outcome.force_commit = true;
            outcome.force_plan_file = true;
        }
        MutationKind::UncertainUpstreamWithEmptyFallback => {
            fs::write(
                root.join("billing/dynamic.ts"),
                "export const getDynamicRate = async (): Promise<number> => {\n  const rel = \"./dynamic-target.ts\";\n  const mod = await import(rel);\n  return mod.dynamicRate + 10;\n};\n",
            )
            .map_err(|e| format!("write dynamic.ts: {e}"))?;
        }
        MutationKind::CorruptSharedCacheBlob => {
            replace_once(
                root,
                "core/math.ts",
                "n * baseScale()",
                "n * baseScale() + 3",
            )?;
            outcome.corrupt_shared_cache = true;
        }
        _ => {}
    }
    Ok(outcome)
}

pub fn git_init_and_commit(root: &Path, message: &str) -> Result<String, String> {
    run_git(root, &["init", "-q"])?;
    run_git(root, &["add", "."])?;
    commit_with_identity(root, message)
}

pub fn git_commit_all(root: &Path, message: &str) -> Result<String, String> {
    run_git(root, &["add", "-A"])?;
    commit_with_identity(root, message)
}

pub fn git_reset_clean(root: &Path, commit: &str) -> Result<(), String> {
    let _ = fs::remove_file(root.join("lang/casetarget.ts"));
    run_git(root, &["reset", "--hard", "-q", commit])?;
    run_git(root, &["clean", "-fdq"])?;
    Ok(())
}

pub fn git_checkout_new_branch(root: &Path, branch: &str, start_ref: &str) -> Result<(), String> {
    run_git(root, &["checkout", "-q", "-B", branch, start_ref])?;
    Ok(())
}

pub fn run_build_dep_script(node_bin: &Path, root: &Path) -> Result<(), String> {
    let output = Command::new(node_bin)
        .arg("build-dep/build.mjs")
        .current_dir(root)
        .output()
        .map_err(|e| format!("spawn build-dep/build.mjs: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("build-dep/build.mjs failed: {stderr}"));
    }
    Ok(())
}

pub fn corrupt_cache_dir(cache_dir: &Path) -> Result<usize, String> {
    if !cache_dir.exists() {
        return Ok(0);
    }
    let mut corrupted = 0usize;
    corrupt_walk(cache_dir, &mut corrupted)?;
    Ok(corrupted)
}

pub fn replace_once(root: &Path, rel: &str, needle: &str, replacement: &str) -> Result<(), String> {
    let path = root.join(rel);
    let content = fs::read_to_string(&path).map_err(|e| format!("read {rel}: {e}"))?;
    if !content.contains(needle) {
        return Err(format!(
            "{rel} does not contain expected pattern `{needle}`"
        ));
    }
    let updated = content.replacen(needle, replacement, 1);
    fs::write(&path, updated).map_err(|e| format!("write {rel}: {e}"))
}

fn commit_with_identity(root: &Path, message: &str) -> Result<String, String> {
    run_git(
        root,
        &[
            "-c",
            "user.name=Dads DST",
            "-c",
            "user.email=dst@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-qm",
            message,
        ],
    )?;
    run_git(root, &["rev-parse", "HEAD"]).map(|s| s.trim().to_owned())
}

fn corrupt_walk(dir: &Path, count: &mut usize) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            corrupt_walk(&path, count)?;
        } else if path.is_file() {
            fs::write(&path, b"{corrupt-dst-blob")
                .map_err(|e| format!("corrupt {}: {e}", path.display()))?;
            *count += 1;
        }
    }
    Ok(())
}

pub fn run_git(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|error| format!("git {:?} failed to spawn: {error}", args))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git {:?} failed: {stderr}", args));
    }
    String::from_utf8(output.stdout).map_err(|e| format!("git utf8: {e}"))
}
