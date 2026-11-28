//! Synthetic plan/task builders and candidate file matching for per-file read-guard audit.

use crate::git::git_untracked_paths;
use crate::manifest::{DeclaredTask, FileNarrowing, TestingManifest};
use crate::protocol::{
    PROTOCOL_SCHEMA_VERSION, PlanCounts, PlanResult, ReadGuardMode, ResolvedScope, TaskDecision,
    TaskReadGuardAllowlist, UndeclaredRead,
};
use crate::scheduler::RunOptions;
use crate::scope::{deepest_project_for_path, path_matches_impact};
use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;

pub(super) fn audit_subrun_options<'a>(options: &RunOptions<'a>) -> RunOptions<'a> {
    RunOptions {
        jobs: options.jobs,
        receipts: None,
        stream_enabled: false,
        graph: options.graph,
        read_guard_mode: Some(ReadGuardMode::Audit),
        read_guard_hook_path: options.read_guard_hook_path,
        workspace_root_raw: options.workspace_root_raw,
        audit_per_file: false,
    }
}

pub(super) fn synthetic_audit_task(base: &DeclaredTask, synth_id: String) -> DeclaredTask {
    let mut synth = base.clone();
    synth.id = synth_id;
    synth.depends_on.clear();
    synth.cache = false;
    synth.execution.batch = None;
    synth
}

pub(super) fn record_reads_for_file(
    target: &mut BTreeSet<UndeclaredRead>,
    reads: &[UndeclaredRead],
    file: &str,
) {
    for read in reads {
        target.insert(UndeclaredRead {
            path: read.path.clone(),
            location: read.location.clone(),
            api: read.api.clone(),
            selected_file: Some(file.to_owned()),
        });
    }
}

pub(super) fn clone_plan(plan: &PlanResult) -> PlanResult {
    PlanResult {
        schema_version: plan.schema_version,
        scope: ResolvedScope {
            kind: plan.scope.kind.clone(),
            base: plan.scope.base.clone(),
            head: plan.scope.head.clone(),
            changed_paths: plan.scope.changed_paths.clone(),
            full_fallback: plan.scope.full_fallback,
        },
        tasks: plan.tasks.clone(),
        issues: plan.issues.clone(),
        complete: plan.complete,
        counts: PlanCounts {
            run: plan.counts.run,
            skip_proven_unaffected: plan.counts.skip_proven_unaffected,
        },
        shard: plan.shard.clone(),
        workspace_fingerprint: plan.workspace_fingerprint.clone(),
    }
}

pub(super) fn synthetic_run_decision(
    id: String,
    project: String,
    selected_files: Vec<String>,
    allowlist: TaskReadGuardAllowlist,
) -> TaskDecision {
    TaskDecision {
        id,
        decision: "run".to_owned(),
        reason: "audit-per-file".to_owned(),
        confidence: "conservative".to_owned(),
        widened: false,
        project,
        causes: Vec::new(),
        reached_files: selected_files.clone(),
        selected_files,
        cache_inputs: None,
        read_guard_allowlist: Some(allowlist),
    }
}

pub(super) fn synthetic_plan(tasks: Vec<TaskDecision>) -> PlanResult {
    let run_count = tasks.len();
    PlanResult {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        scope: ResolvedScope {
            kind: "all".to_owned(),
            base: None,
            head: None,
            changed_paths: Vec::new(),
            full_fallback: false,
        },
        tasks,
        issues: Vec::new(),
        complete: true,
        counts: PlanCounts {
            run: run_count,
            skip_proven_unaffected: 0,
        },
        shard: None,
        workspace_fingerprint: None,
    }
}

pub(super) fn matching_files_for_task(
    manifest: &TestingManifest,
    task: &DeclaredTask,
    narrowing: &FileNarrowing,
    candidate_files: &BTreeSet<String>,
) -> Vec<String> {
    let mut matches = Vec::new();
    for rel in candidate_files {
        if is_ignored_segment(rel) {
            continue;
        }
        if manifest
            .workspace
            .ignore_paths
            .iter()
            .any(|pattern| path_matches_impact(rel, pattern))
        {
            continue;
        }
        let Some(owner) = deepest_project_for_path(&manifest.projects, rel) else {
            continue;
        };
        if owner.id != task.project {
            continue;
        }
        if !narrowing.suffixes.iter().any(|s| rel.ends_with(s)) {
            continue;
        }
        if narrowing.exclude_suffixes.iter().any(|e| rel.ends_with(e)) {
            continue;
        }
        if is_excluded_by_args(&task.execution.args, rel) {
            continue;
        }
        matches.push(rel.clone());
    }
    matches
}

fn is_excluded_by_args(args: &[String], rel: &str) -> bool {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--exclude" {
            if let Some(next) = iter.next()
                && next.trim_start_matches("./") == rel
            {
                return true;
            }
        } else if let Some(val) = arg.strip_prefix("--exclude=")
            && val.trim_start_matches("./") == rel
        {
            return true;
        }
    }
    false
}

fn is_ignored_segment(rel: &str) -> bool {
    rel.split('/').any(|seg| {
        matches!(
            seg,
            "node_modules" | "dist" | ".git" | "target" | "fixtures" | "__fixtures__" | "__mocks__"
        )
    })
}

pub(super) fn workspace_candidate_files(workspace_root: &Path) -> BTreeSet<String> {
    let mut files = BTreeSet::new();
    if let Ok(output) = Command::new("git")
        .args(["ls-files", "-z"])
        .current_dir(workspace_root)
        .output()
        && output.status.success()
    {
        for raw in output.stdout.split(|&b| b == 0) {
            if raw.is_empty() {
                continue;
            }
            if let Ok(s) = std::str::from_utf8(raw) {
                files.insert(s.replace('\\', "/"));
            }
        }
    }
    if let Ok(untracked) = git_untracked_paths(workspace_root) {
        files.extend(untracked);
    }
    files
}
