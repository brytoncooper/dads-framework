//! Specialized Section B timeline #77: `module-boundaries-violation-and-fix`
//! (`dad-test check-boundaries` full & `--base` detection and post-fix clearance).

use crate::dad_client::{NativeRequestPayload, invoke_dad};
use crate::invariants_report::{FailureRecord, WorkerAccumulator, record_soundness_miss};
use crate::model::{MutationKind, WorkspaceShape};
use crate::mutations::git_commit_all;
use crate::runner::DstConfig;
use std::fs;
use std::path::Path;

pub struct SpecialTimelineCtx<'a> {
    pub config: &'a DstConfig,
    pub workspace_dir: &'a Path,
    pub temp_root: &'a Path,
    pub shared_cache_dir: &'a Path,
    pub baseline_sha: &'a str,
    pub shape: &'a WorkspaceShape,
    pub mutation: MutationKind,
    pub step_idx: usize,
    pub node_dir: Option<&'a Path>,
}

pub fn run_boundaries_timeline(
    ctx: &SpecialTimelineCtx<'_>,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    acc.by_mutation
        .entry(ctx.mutation.as_str().to_owned())
        .or_default()
        .steps += 1;
    let base_full = invoke_boundaries(ctx, None, None)?;
    if !base_full.is_empty() {
        return Err(format!(
            "baseline check-boundaries had unexpected violations: {base_full:?}"
        ));
    }

    let variant = (ctx.shape.seed as usize).wrapping_add(ctx.step_idx) % 4;
    let (rel_file, orig_content, expected_rules) =
        inject_boundary_violation(ctx.workspace_dir, variant)?;
    let head_sha = if ctx.shape.commit_before_plan {
        Some(git_commit_all(ctx.workspace_dir, "dst boundary violation")?)
    } else {
        None
    };

    acc.by_mutation
        .entry(ctx.mutation.as_str().to_owned())
        .or_default()
        .oracle_failures += 1;
    acc.oracle_failures_total += 1;
    let mut had_miss =
        verify_boundary_detection(ctx, rel_file, expected_rules, head_sha.as_deref(), acc)?;

    write_ws(ctx.workspace_dir, rel_file, &orig_content)?;
    let fix_head = if ctx.shape.commit_before_plan {
        Some(git_commit_all(ctx.workspace_dir, "dst boundary fix")?)
    } else {
        None
    };
    let after_full = invoke_boundaries(ctx, None, None)?;
    let after_scoped = invoke_boundaries(ctx, Some(ctx.baseline_sha), fix_head.as_deref())?;
    if !after_full.is_empty() || !after_scoped.is_empty() {
        had_miss = true;
        record_soundness_miss(
            make_failure(
                ctx,
                "boundaries-fix-stale",
                "check-boundaries",
                rel_file,
                format!(
                    "expected 0 violations after fix: full={after_full:?} scoped={after_scoped:?}"
                ),
            ),
            false,
            acc,
        );
    }
    Ok(had_miss)
}

fn inject_boundary_violation(
    root: &Path,
    variant: usize,
) -> Result<(&'static str, String, &'static [&'static str]), String> {
    match variant {
        0 => {
            let rel = "bnd-browser/app.ts";
            let orig = read_ws(root, rel)?;
            write_ws(
                root,
                rel,
                "import { sharedVal } from \"@bnd/shared\";\nimport { dbVal } from \"@bnd/server\";\nexport const appVal = sharedVal + dbVal;\n",
            )?;
            Ok((
                rel,
                orig,
                &[
                    "only-depend-on-libs-with-tags",
                    "not-depend-on-libs-with-tags",
                ],
            ))
        }
        1 => {
            let rel = "bnd-browser/app.ts";
            let orig = read_ws(root, rel)?;
            write_ws(
                root,
                rel,
                "import \"pg\";\nimport { sharedVal } from \"@bnd/shared\";\nexport const appVal = sharedVal;\n",
            )?;
            Ok((rel, orig, &["banned-external-import"]))
        }
        2 => {
            let rel = "bnd-browser/app.ts";
            let orig = read_ws(root, rel)?;
            write_ws(
                root,
                rel,
                "import \"undeclared-transitive-pkg\";\nimport { sharedVal } from \"@bnd/shared\";\nexport const appVal = sharedVal;\n",
            )?;
            Ok((rel, orig, &["ban-transitive-dependency"]))
        }
        _ => {
            let rel = "bnd-shared/util.ts";
            let orig = read_ws(root, rel)?;
            write_ws(
                root,
                rel,
                "import { appVal } from \"@bnd/browser\";\nexport const sharedVal = 2 + Number(Boolean(appVal));\n",
            )?;
            Ok((rel, orig, &["circular-dependency"]))
        }
    }
}

fn verify_boundary_detection(
    ctx: &SpecialTimelineCtx<'_>,
    rel_file: &str,
    expected_rules: &[&str],
    head_sha: Option<&str>,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    let mut had_miss = false;
    let full_rules = invoke_boundaries(ctx, None, None)?;
    if !full_rules
        .iter()
        .any(|r| expected_rules.contains(&r.as_str()))
    {
        had_miss = true;
        record_soundness_miss(
            make_failure(
                ctx,
                "boundaries-full-miss",
                "check-boundaries",
                rel_file,
                format!("expected one of {expected_rules:?}, got {full_rules:?}"),
            ),
            false,
            acc,
        );
    }
    let scoped_rules = invoke_boundaries(ctx, Some(ctx.baseline_sha), head_sha)?;
    if !scoped_rules
        .iter()
        .any(|r| expected_rules.contains(&r.as_str()))
    {
        had_miss = true;
        record_soundness_miss(
            make_failure(
                ctx,
                "boundaries-base-miss",
                "check-boundaries",
                rel_file,
                format!("--base expected one of {expected_rules:?}, got {scoped_rules:?}"),
            ),
            false,
            acc,
        );
    }
    Ok(had_miss)
}

fn invoke_boundaries(
    ctx: &SpecialTimelineCtx<'_>,
    base: Option<&str>,
    head: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut req = NativeRequestPayload::new(
        "check-boundaries",
        ctx.workspace_dir.to_string_lossy().into_owned(),
    );
    req.base = base.map(str::to_owned);
    req.head = head.map(str::to_owned);
    let resp = invoke_dad(&ctx.config.dad_bin, &req, ctx.node_dir)?;
    if !resp.envelope.ok {
        return Err(format!(
            "check-boundaries failed: {:?}",
            resp.envelope.error
        ));
    }
    let boundaries = resp
        .envelope
        .result
        .and_then(|r| r.boundaries)
        .ok_or_else(|| "check-boundaries missing boundaries result".to_owned())?;
    Ok(boundaries.violations.into_iter().map(|v| v.rule).collect())
}

fn read_ws(root: &Path, rel: &str) -> Result<String, String> {
    fs::read_to_string(root.join(rel)).map_err(|e| format!("read {rel}: {e}"))
}

fn write_ws(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    fs::write(root.join(rel), content).map_err(|e| format!("write {rel}: {e}"))
}

pub(crate) fn make_failure<'a>(
    ctx: &'a SpecialTimelineCtx<'_>,
    kind: &'a str,
    task_id: &'a str,
    test_file: &'a str,
    detail: String,
) -> FailureRecord<'a> {
    FailureRecord {
        config: ctx.config,
        workspace_dir: ctx.workspace_dir,
        shape: ctx.shape,
        step_idx: ctx.step_idx,
        mutation: ctx.mutation,
        kind,
        task_id,
        test_file,
        detail,
    }
}
