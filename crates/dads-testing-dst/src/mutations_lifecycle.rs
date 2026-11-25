//! Section D (#86-#95) mutations: Next.js special paths, case-only renames, untracked failing
//! tests, file delete/`git mv`/deletion hunks, staged-vs-unstaged split diffs, multi-commit/
//! merge/detached/worktree git topologies, CRLF/BOM/binary/chmod, concurrent cache writers,
//! same-size/same-ms + env drift, and CLI filters/weighted shards/stale `--plan-file`.

use crate::generator_lifecycle::set_file_mode;
use crate::generator_section_a::reset_section_a_untracked_baseline;
use crate::generator_subsystems::reset_subsystems_untracked_baseline;
use crate::model::{MutationKind, WorkspaceShape};
use crate::mutations::{
    AppliedMutation, SpecialTimeline, git_checkout_new_branch, git_commit_all, replace_once,
    run_build_dep_script, run_git,
};
use crate::mutations_advanced::AdvancedMutationPaths;
use crate::node_oracle::OracleTestSpec;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub fn apply_section_d_mutation(
    paths: &AdvancedMutationPaths<'_>,
    shape: &WorkspaceShape,
    kind: MutationKind,
    step_idx: usize,
) -> Result<AppliedMutation, String> {
    let root = paths.workspace_dir;
    let variant = (shape.seed as usize).wrapping_add(step_idx);
    let mut applied = AppliedMutation::default();
    match kind {
        MutationKind::NextjsSpecialPathChars => apply_nextjs_path_mutation(root, variant)?,
        MutationKind::CaseOnlyFileRename => apply_case_only_rename(root)?,
        MutationKind::NewUntrackedFailingTestFile => {
            apply_new_untracked_failing_test(root, variant, &mut applied)?;
        }
        MutationKind::FileDeleteGitMvAndDeletionHunk => {
            apply_delete_mv_hunk_mutation(root, variant, &mut applied)?;
        }
        MutationKind::StagedVsUnstagedSplitDiff => {
            apply_staged_vs_unstaged(root, &mut applied)?;
        }
        MutationKind::MultiCommitMergeDetachedAndWorktree => {
            apply_git_topology_mutation(paths, variant, step_idx, &mut applied)?;
        }
        MutationKind::EncodingCrlfBomBinaryChmod => apply_encoding_chmod_mutation(root, variant)?,
        MutationKind::ConcurrentParallelCacheWriters => {
            applied.special_timeline = Some(SpecialTimeline::ConcurrentCacheWriters);
        }
        MutationKind::SameSizeSameMsEditAndEnvDrift => {
            apply_same_size_or_env_drift(root, variant, &mut applied)?;
        }
        MutationKind::CliFiltersWeightedShardAndStalePlanFile => {
            applied.special_timeline = Some(SpecialTimeline::CliFiltersShardStalePlan);
        }
        _ => return Err(format!("not a section D mutation: {kind:?}")),
    }
    Ok(applied)
}

fn apply_nextjs_path_mutation(root: &Path, variant: usize) -> Result<(), String> {
    match variant % 3 {
        0 => replace_once(
            root,
            "next-app/app/(auth)/[id]/[...slug]/@slot/data file.ts",
            "routeVal = 2",
            "routeVal = 9",
        ),
        1 => replace_once(
            root,
            "next-app/app/(auth)/[id]/[...slug]/@slot/café.ts",
            "cafeVal = 3",
            "cafeVal = 9",
        ),
        _ => replace_once(
            root,
            "next-app/app/(auth)/[id]/[...slug]/@slot/meta [v1].json",
            "\"ok\":true",
            "\"ok\":false",
        ),
    }
}

fn apply_case_only_rename(root: &Path) -> Result<(), String> {
    run_git(root, &["mv", "lang/CaseTarget.ts", "lang/case-tmp.ts"])?;
    run_git(root, &["mv", "lang/case-tmp.ts", "lang/casetarget.ts"])?;
    fs::write(
        root.join("lang/casetarget.ts"),
        "export const caseVal = 9;\n",
    )
    .map_err(|e| format!("write casetarget.ts: {e}"))
}

fn apply_new_untracked_failing_test(
    root: &Path,
    variant: usize,
    applied: &mut AppliedMutation,
) -> Result<(), String> {
    let rel = "adv/brand-new-untracked.test.ts";
    fs::write(
        root.join(rel),
        "throw new Error(\"untracked failing test\");\n",
    )
    .map_err(|e| format!("write {rel}: {e}"))?;
    applied.extra_oracle_tests.push((
        "adv:test".to_owned(),
        OracleTestSpec {
            file: rel.to_owned(),
            setup_file: None,
            env: BTreeMap::new(),
        },
    ));
    if variant.is_multiple_of(2) {
        applied.force_untracked = true;
    } else {
        applied.force_commit = true;
    }
    Ok(())
}

fn apply_delete_mv_hunk_mutation(
    root: &Path,
    variant: usize,
    applied: &mut AppliedMutation,
) -> Result<(), String> {
    match variant % 3 {
        0 => {
            fs::remove_file(root.join("lang/del-mod.ts"))
                .map_err(|e| format!("remove del-mod.ts: {e}"))?;
            fs::remove_file(root.join("adv/enums.test.ts"))
                .map_err(|e| format!("remove enums.test.ts: {e}"))?;
            applied
                .deleted_test_files
                .push("adv/enums.test.ts".to_owned());
        }
        1 => {
            replace_once(root, "lang/del-hunk.ts", "export const dropVal = 2;\n", "")?;
        }
        _ => {
            run_git(root, &["mv", "lang/mv-src.ts", "core/mv-dst.ts"])?;
        }
    }
    Ok(())
}

fn apply_staged_vs_unstaged(root: &Path, applied: &mut AppliedMutation) -> Result<(), String> {
    replace_once(
        root,
        "core/math.ts",
        "// core math module",
        "// staged benign comment",
    )?;
    run_git(root, &["add", "core/math.ts"])?;
    replace_once(
        root,
        "core/math.ts",
        "n * baseScale()",
        "n * baseScale() + 12",
    )?;
    applied.force_untracked = true;
    Ok(())
}

fn apply_git_topology_mutation(
    paths: &AdvancedMutationPaths<'_>,
    variant: usize,
    step_idx: usize,
    applied: &mut AppliedMutation,
) -> Result<(), String> {
    let root = paths.workspace_dir;
    let baseline = paths.baseline_sha;
    match variant % 4 {
        0 => {
            replace_once(
                root,
                "core/math.ts",
                "n * baseScale()",
                "n * baseScale() + 10",
            )?;
            let _ = git_commit_all(root, "commit 1 break core")?;
            replace_once(
                root,
                "billing/pure.ts",
                "export const unusedPureExport = 7;",
                "export const unusedPureExport = 71;",
            )?;
            let head = git_commit_all(root, "commit 2 unrelated pure edit")?;
            applied.git_head_override = Some(head);
        }
        1 => {
            let side = format!("dst-merge-side-{step_idx}");
            let main_br = format!("dst-merge-main-{step_idx}");
            git_checkout_new_branch(root, &side, baseline)?;
            replace_once(root, "lang/hop-a.ts", "origVal = 2", "origVal = 9")?;
            let _ = git_commit_all(root, "side branch breaking change")?;
            git_checkout_new_branch(root, &main_br, baseline)?;
            replace_once(
                root,
                "unrelated/control.test.ts",
                "1 + 1 !== 2",
                "2 + 2 !== 4",
            )?;
            let _ = git_commit_all(root, "main branch passing comment")?;
            run_git(
                root,
                &[
                    "-c",
                    "user.name=Dads DST",
                    "-c",
                    "user.email=dst@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "merge",
                    "--no-ff",
                    "-qm",
                    "dst merge commit",
                    &side,
                ],
            )?;
            let head = run_git(root, &["rev-parse", "HEAD"])?.trim().to_owned();
            applied.git_head_override = Some(head);
        }
        2 => {
            run_git(root, &["checkout", "-q", "--detach", baseline])?;
            replace_once(
                root,
                "core/math.ts",
                "n * baseScale()",
                "n * baseScale() + 11",
            )?;
            let head = git_commit_all(root, "detached head breaking change")?;
            applied.git_head_override = Some(head);
        }
        _ => {
            let wt_dir = paths.temp_root.join(format!("wt-linked-{step_idx}"));
            let _ = fs::remove_dir_all(&wt_dir);
            let wt_str = wt_dir.to_string_lossy().into_owned();
            run_git(
                root,
                &["worktree", "add", "-q", "--detach", &wt_str, baseline],
            )?;
            reset_section_a_untracked_baseline(&wt_dir)?;
            reset_subsystems_untracked_baseline(&wt_dir)?;
            run_build_dep_script(paths.node_bin, &wt_dir)?;
            replace_once(
                &wt_dir,
                "core/math.ts",
                "n * baseScale()",
                "n * baseScale() + 13",
            )?;
            applied.worktree_override_dir = Some(wt_dir);
            applied.force_untracked = true;
        }
    }
    Ok(())
}

fn apply_encoding_chmod_mutation(root: &Path, variant: usize) -> Result<(), String> {
    match variant % 4 {
        0 => fs::write(
            root.join("settings/encoding-crlf.txt"),
            "line1\r\nline2\r\n",
        )
        .map_err(|e| format!("write crlf: {e}")),
        1 => {
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(b"{\"v\":2}\n");
            fs::write(root.join("settings/encoding-bom.json"), bytes)
                .map_err(|e| format!("write bom: {e}"))
        }
        2 => fs::write(
            root.join("settings/binary-fixture.bin"),
            [0x00, 0x01, 0x02, 0x99],
        )
        .map_err(|e| format!("write binary: {e}")),
        _ => set_file_mode(root.join("settings/exec-flag.sh").as_path(), 0o755),
    }
}

fn apply_same_size_or_env_drift(
    root: &Path,
    variant: usize,
    applied: &mut AppliedMutation,
) -> Result<(), String> {
    match variant % 3 {
        0 => {
            replace_once(
                root,
                "lang/same-size.ts",
                "exactDigit = 2;",
                "exactDigit = 9;",
            )?;
        }
        1 => {
            applied.oracle_env_override = Some((
                "adv-cache/same-size-env.test.ts".to_owned(),
                "TZ".to_owned(),
                "Pacific/Kiritimati".to_owned(),
            ));
            applied
                .dad_process_env
                .push(("TZ".to_owned(), "Pacific/Kiritimati".to_owned()));
            applied.force_only_tasks = vec!["adv-cache:test".to_owned()];
        }
        _ => {
            applied.oracle_env_override = Some((
                "adv-cache/same-size-env.test.ts".to_owned(),
                "NODE_ENV".to_owned(),
                "dst-broken-env".to_owned(),
            ));
            applied
                .dad_process_env
                .push(("NODE_ENV".to_owned(), "dst-broken-env".to_owned()));
            applied.force_only_tasks = vec!["adv-cache:test".to_owned()];
        }
    }
    Ok(())
}
