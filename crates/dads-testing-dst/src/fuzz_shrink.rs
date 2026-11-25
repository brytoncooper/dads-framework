//! Automatic delta-debugging shrinker (`ddmin`) for failing generative chaos scenarios.
//!
//! Minimizes any failing `(ChaosWorkspaceSpec, Vec<ChaosStep>)` through 4 stages:
//! 1. Truncate trailing steps after the first failing step.
//! 2. Delta-debug (`ddmin`) drop earlier steps that do not affect reproduction.
//! 3. Delta-debug (`ddmin`) drop individual `ChaosOp`s inside each surviving compound step.
//! 4. Prune unreferenced projects & modules from `ChaosWorkspaceSpec`.

use crate::fuzz_graph::ChaosWorkspaceSpec;
use crate::fuzz_ops::ChaosStep;
use crate::fuzz_shrink_prune::try_prune_project;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct ShrinkOpsResult<T> {
    pub minimal: Vec<T>,
    pub iterations: usize,
    pub evaluations: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShrunkChaosRepro {
    pub original_projects: usize,
    pub shrunk_projects: usize,
    pub original_modules: usize,
    pub shrunk_modules: usize,
    pub original_steps: usize,
    pub shrunk_steps: usize,
    pub original_ops: usize,
    pub shrunk_ops: usize,
    pub evaluations: usize,
    pub steps: Vec<ChaosStep>,
}

/// Classic Zeller delta-debugging (`ddmin`) reducing `ops` to a 1-minimal failing subset.
///
/// For a single-fault slice of length 10, converges to the exact 1-op reproducer in <= 8
/// evaluations (4 loop iterations).
pub fn shrink_ops<T: Clone, F>(ops: &[T], reproduces: F) -> ShrinkOpsResult<T>
where
    F: FnMut(&[T]) -> bool,
{
    shrink_ops_budgeted(ops, usize::MAX, reproduces)
}

pub fn shrink_ops_budgeted<T: Clone, F>(
    ops: &[T],
    max_evals: usize,
    mut reproduces: F,
) -> ShrinkOpsResult<T>
where
    F: FnMut(&[T]) -> bool,
{
    let mut cur = ops.to_vec();
    let mut n = 2usize;
    let mut iterations = 0usize;
    let mut evaluations = 0usize;

    while cur.len() >= 2 && evaluations < max_evals {
        iterations += 1;
        let chunks = partition_ranges(cur.len(), n);
        let mut reduced = false;

        for &(start, end) in &chunks {
            if evaluations >= max_evals {
                break;
            }
            let subset = cur[start..end].to_vec();
            evaluations += 1;
            if reproduces(&subset) {
                cur = subset;
                n = 2;
                reduced = true;
                break;
            }
        }
        if reduced {
            continue;
        }
        if n > 2 {
            for &(start, end) in &chunks {
                if evaluations >= max_evals {
                    break;
                }
                let mut complement = Vec::with_capacity(cur.len() - (end - start));
                complement.extend_from_slice(&cur[..start]);
                complement.extend_from_slice(&cur[end..]);
                evaluations += 1;
                if reproduces(&complement) {
                    cur = complement;
                    n = (n - 1).max(2);
                    reduced = true;
                    break;
                }
            }
        }
        if reduced {
            continue;
        }
        if n >= cur.len() {
            break;
        }
        n = (n * 2).min(cur.len());
    }

    ShrinkOpsResult {
        minimal: cur,
        iterations,
        evaluations,
    }
}

pub fn shrink_chaos_failure<F>(
    spec: &ChaosWorkspaceSpec,
    steps: &[ChaosStep],
    fail_step_idx: usize,
    max_evals: usize,
    mut reproduces: F,
) -> (ChaosWorkspaceSpec, ShrunkChaosRepro)
where
    F: FnMut(&ChaosWorkspaceSpec, &[ChaosStep]) -> bool,
{
    let orig_ops: usize = steps.iter().map(|s| s.ops.len()).sum();
    let mut budget_left = max_evals;
    let mut total_evals = 0usize;

    // Stage 1: truncate trailing steps after the first failing step.
    let end = (fail_step_idx + 1).min(steps.len());
    let mut cur_spec = spec.clone();
    let mut cur_steps = steps[..end].to_vec();

    // Stage 2: ddmin drop earlier steps.
    if cur_steps.len() >= 2 && budget_left > 0 {
        let step_res =
            shrink_ops_budgeted(&cur_steps, budget_left, |cand| reproduces(&cur_spec, cand));
        total_evals += step_res.evaluations;
        budget_left = budget_left.saturating_sub(step_res.evaluations);
        cur_steps = step_res.minimal;
    }

    // Stage 3: ddmin drop individual ChaosOps inside each remaining step.
    for idx in 0..cur_steps.len() {
        if cur_steps[idx].ops.len() < 2 || budget_left == 0 {
            continue;
        }
        let base_steps = cur_steps.clone();
        let op_res = shrink_ops_budgeted(&base_steps[idx].ops, budget_left, |cand_ops| {
            let mut trial = base_steps.clone();
            trial[idx].ops = cand_ops.to_vec();
            reproduces(&cur_spec, &trial)
        });
        total_evals += op_res.evaluations;
        budget_left = budget_left.saturating_sub(op_res.evaluations);
        cur_steps[idx].ops = op_res.minimal;
    }

    // Stage 4: drop unused projects & modules from ChaosWorkspaceSpec.
    let mut p_idx = cur_spec.projects.len();
    while p_idx > 0 && cur_spec.projects.len() > 2 && budget_left > 0 {
        p_idx -= 1;
        if let Some((pruned_spec, remapped_steps)) = try_prune_project(&cur_spec, &cur_steps, p_idx)
        {
            total_evals += 1;
            budget_left = budget_left.saturating_sub(1);
            if reproduces(&pruned_spec, &remapped_steps) {
                cur_spec = pruned_spec;
                cur_steps = remapped_steps;
            }
        }
    }

    let shrunk_ops: usize = cur_steps.iter().map(|s| s.ops.len()).sum();
    let report = ShrunkChaosRepro {
        original_projects: spec.projects.len(),
        shrunk_projects: cur_spec.projects.len(),
        original_modules: spec.modules.len(),
        shrunk_modules: cur_spec.modules.len(),
        original_steps: steps.len(),
        shrunk_steps: cur_steps.len(),
        original_ops: orig_ops,
        shrunk_ops,
        evaluations: total_evals,
        steps: cur_steps,
    };
    (cur_spec, report)
}

fn partition_ranges(len: usize, parts: usize) -> Vec<(usize, usize)> {
    let k = parts.clamp(1, len);
    let base = len / k;
    let rem = len % k;
    let mut out = Vec::with_capacity(k);
    let mut cursor = 0usize;
    for i in 0..k {
        let size = base + usize::from(i < rem);
        out.push((cursor, cursor + size));
        cursor += size;
    }
    out
}
