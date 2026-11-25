//! Chaos DST summary types, multi-worker aggregation, and human-readable reproducer output.

use crate::fuzz_chaos::ChaosConfig;
use crate::fuzz_verify::ChaosFailure;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChaosSummary {
    pub scenarios_run: usize,
    pub steps_executed: usize,
    pub oracle_failures_total: usize,
    pub soundness_misses_total: usize,
    pub stale_cache_hits_total: usize,
    pub snapshot_parity_checks: usize,
    pub snapshot_parity_divergences: usize,
    pub cache_integrity_violations: usize,
    pub harness_errors: usize,
    pub precision_checks_total: usize,
    pub precision_skips_total: usize,
    pub elapsed_ms: u64,
    pub sample_failures: Vec<ChaosFailure>,
}

pub fn merge_chaos_summary(dst: &mut ChaosSummary, src: ChaosSummary, max_samples: usize) {
    dst.scenarios_run += src.scenarios_run;
    dst.steps_executed += src.steps_executed;
    dst.oracle_failures_total += src.oracle_failures_total;
    dst.soundness_misses_total += src.soundness_misses_total;
    dst.stale_cache_hits_total += src.stale_cache_hits_total;
    dst.snapshot_parity_checks += src.snapshot_parity_checks;
    dst.snapshot_parity_divergences += src.snapshot_parity_divergences;
    dst.cache_integrity_violations += src.cache_integrity_violations;
    dst.harness_errors += src.harness_errors;
    dst.precision_checks_total += src.precision_checks_total;
    dst.precision_skips_total += src.precision_skips_total;
    for failure in src.sample_failures {
        if dst.sample_failures.len() < max_samples {
            dst.sample_failures.push(failure);
        }
    }
}

pub fn print_chaos_summary(summary: &ChaosSummary, config: &ChaosConfig) {
    let skip_pct = if summary.precision_checks_total == 0 {
        0.0
    } else {
        (summary.precision_skips_total as f64 / summary.precision_checks_total as f64) * 100.0
    };
    println!(
        "Chaos DST complete: {} scenarios ({} un-reset steps) in {}ms | oracle_failures={} | soundness_misses={} (stale_cache_hits={}) | snapshot_parity_divergences={}/{} | cache_integrity_violations={} | harness_errors={} | clean_comment_skip={:.1}% ({}/{})",
        summary.scenarios_run,
        summary.steps_executed,
        summary.elapsed_ms,
        summary.oracle_failures_total,
        summary.soundness_misses_total,
        summary.stale_cache_hits_total,
        summary.snapshot_parity_divergences,
        summary.snapshot_parity_checks,
        summary.cache_integrity_violations,
        summary.harness_errors,
        skip_pct,
        summary.precision_skips_total,
        summary.precision_checks_total,
    );
    for failure in summary.sample_failures.iter().take(12) {
        println!(
            "  seed={} step={} kind={} task={} file={} ({}p/{}m) | {}",
            failure.seed,
            failure.step,
            failure.kind,
            failure.task_id,
            failure.test_file,
            failure.projects,
            failure.modules,
            failure.detail,
        );
        if let Some(shrunk) = &failure.shrunk {
            println!(
                "    shrunk ({} evals): projects {}->{}, modules {}->{}, steps {}->{}, ops {}->{}",
                shrunk.evaluations,
                shrunk.original_projects,
                shrunk.shrunk_projects,
                shrunk.original_modules,
                shrunk.shrunk_modules,
                shrunk.original_steps,
                shrunk.shrunk_steps,
                shrunk.original_ops,
                shrunk.shrunk_ops,
            );
            for (idx, step) in shrunk.steps.iter().enumerate() {
                println!("      step {idx}: {:?}", step.ops);
            }
        }
        println!(
            "    repro: dads-testing-dst --bin {} --chaos 1 --chaos-steps {} --seed {} --shrink --keep-failed",
            config.dad_bin.display(),
            config.steps_per_scenario,
            failure.seed,
        );
    }
}
