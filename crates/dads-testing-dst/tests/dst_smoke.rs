#![allow(clippy::unwrap_used, clippy::expect_used)]

use dads_testing_dst::{DstConfig, MutationKind, run_dst_sweep};
use std::path::PathBuf;

fn sibling_dad_bin() -> PathBuf {
    let exe = std::env::current_exe().expect("current_exe");
    let target_dir = exe
        .parent()
        .and_then(|p| p.parent())
        .expect("target profile dir");
    target_dir.join("dad-test")
}

fn find_node() -> PathBuf {
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join("node");
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from("node")
}

#[test]
fn dst_harness_executes_all_58_mutations_with_zero_harness_errors() {
    let dad_bin = sibling_dad_bin();
    if !dad_bin.is_file() {
        return;
    }
    let config = DstConfig {
        dad_bin,
        node_bin: find_node(),
        scenarios: MutationKind::ALL.len(),
        steps_per_scenario: 1,
        base_seed: 42,
        jobs: 4,
        keep_failed: false,
        max_sample_failures: 25,
        filter_mutation: None,
    };
    let summary = run_dst_sweep(&config).expect("DST sweep executes cleanly");
    assert_eq!(summary.scenarios_run, MutationKind::ALL.len());
    assert_eq!(
        summary.harness_errors, 0,
        "harness errors: {:?}",
        summary.sample_failures
    );
    assert_eq!(
        summary.soundness_misses_total, 0,
        "soundness misses detected: {:#?}",
        summary.sample_failures
    );
    assert_eq!(
        summary.cache_integrity_violations, 0,
        "cache integrity violations: {:#?}",
        summary.sample_failures
    );
}
