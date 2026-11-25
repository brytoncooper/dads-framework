//! Worker accumulator, failure-sample recording, and multi-worker summary merge for DST.

use crate::model::{DstSummary, MutationKind, MutationStats, SoundnessFailure, WorkspaceShape};
use crate::runner::DstConfig;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Default)]
pub struct WorkerAccumulator {
    pub scenarios_run: usize,
    pub steps_executed: usize,
    pub oracle_failures_total: usize,
    pub soundness_misses_total: usize,
    pub stale_cache_hits_total: usize,
    pub cache_integrity_violations: usize,
    pub harness_errors: usize,
    pub precision_checks_total: usize,
    pub precision_skips_total: usize,
    pub by_mutation: BTreeMap<String, MutationStats>,
    pub sample_failures: Vec<SoundnessFailure>,
}

pub struct FailureRecord<'a> {
    pub config: &'a DstConfig,
    pub workspace_dir: &'a Path,
    pub shape: &'a WorkspaceShape,
    pub step_idx: usize,
    pub mutation: MutationKind,
    pub kind: &'a str,
    pub task_id: &'a str,
    pub test_file: &'a str,
    pub detail: String,
}

pub fn record_soundness_miss(
    rec: FailureRecord<'_>,
    is_stale_cache: bool,
    acc: &mut WorkerAccumulator,
) {
    let stats = acc
        .by_mutation
        .entry(rec.mutation.as_str().to_owned())
        .or_default();
    stats.soundness_misses += 1;
    acc.soundness_misses_total += 1;
    if is_stale_cache {
        stats.stale_cache_hits += 1;
        acc.stale_cache_hits_total += 1;
    }
    push_sample_failure(rec, acc);
}

pub fn record_cache_integrity_violation(rec: FailureRecord<'_>, acc: &mut WorkerAccumulator) {
    acc.cache_integrity_violations += 1;
    push_sample_failure(rec, acc);
}

fn push_sample_failure(rec: FailureRecord<'_>, acc: &mut WorkerAccumulator) {
    if acc.sample_failures.len() < rec.config.max_sample_failures {
        acc.sample_failures.push(SoundnessFailure {
            seed: rec.shape.seed,
            step: rec.step_idx,
            mutation: rec.mutation,
            kind: rec.kind.to_owned(),
            task_id: rec.task_id.to_owned(),
            test_file: rec.test_file.to_owned(),
            detail: rec.detail,
            shape: rec.shape.clone(),
            kept_dir: rec
                .config
                .keep_failed
                .then(|| rec.workspace_dir.to_string_lossy().into_owned()),
        });
    }
}

pub fn merge_accumulator(summary: &mut DstSummary, acc: WorkerAccumulator, max_samples: usize) {
    summary.scenarios_run += acc.scenarios_run;
    summary.steps_executed += acc.steps_executed;
    summary.oracle_failures_total += acc.oracle_failures_total;
    summary.soundness_misses_total += acc.soundness_misses_total;
    summary.stale_cache_hits_total += acc.stale_cache_hits_total;
    summary.cache_integrity_violations += acc.cache_integrity_violations;
    summary.harness_errors += acc.harness_errors;
    summary.precision_checks_total += acc.precision_checks_total;
    summary.precision_skips_total += acc.precision_skips_total;
    for (name, stats) in acc.by_mutation {
        let entry = summary.by_mutation.entry(name).or_default();
        entry.steps += stats.steps;
        entry.oracle_failures += stats.oracle_failures;
        entry.soundness_misses += stats.soundness_misses;
        entry.stale_cache_hits += stats.stale_cache_hits;
        entry.precision_checks += stats.precision_checks;
        entry.precision_skips += stats.precision_skips;
    }
    for failure in acc.sample_failures {
        if summary.sample_failures.len() < max_samples {
            summary.sample_failures.push(failure);
        }
    }
}
