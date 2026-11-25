#![allow(clippy::unwrap_used, clippy::expect_used)]

use dads_testing_dst::fuzz_graph::generate_chaos_workspace;
use dads_testing_dst::fuzz_ops::generate_chaos_steps;
use dads_testing_dst::fuzz_shrink::{shrink_chaos_failure, shrink_ops};
use dads_testing_dst::{ChaosConfig, MutationKind, run_chaos_sweep};
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
fn curated_catalog_has_all_95_families() {
    assert_eq!(MutationKind::ALL.len(), 95);
    assert_eq!(
        MutationKind::parse("undeclared-dynamic-fs-read-enforced"),
        Some(MutationKind::UndeclaredDynamicFsReadEnforced)
    );
    assert_eq!(
        MutationKind::parse("audit-fix-remediates-dynamic-read"),
        Some(MutationKind::AuditFixRemediatesDynamicRead)
    );
}

#[test]
fn chaos_workspace_and_steps_are_deterministic_for_same_seed() {
    let spec_a = generate_chaos_workspace(1337);
    let spec_b = generate_chaos_workspace(1337);
    assert_eq!(spec_a, spec_b);
    assert!((3..=12).contains(&spec_a.projects.len()));
    assert!((15..=50).contains(&spec_a.modules.len()));

    let steps_a = generate_chaos_steps(&spec_a, 1337, 6);
    let steps_b = generate_chaos_steps(&spec_b, 1337, 6);
    assert_eq!(steps_a, steps_b);
    assert_eq!(steps_a.len(), 6);

    let spec_other = generate_chaos_workspace(1338);
    assert_ne!(spec_a, spec_other);
}

#[test]
fn shrink_ops_reduces_ten_op_single_fault_sequence_under_ten_iterations() {
    let ops: Vec<usize> = (0..10).collect();
    for fault in 0..10 {
        let result = shrink_ops(&ops, |subset| subset.contains(&fault));
        assert_eq!(result.minimal, vec![fault]);
        assert!(
            result.iterations < 10,
            "expected < 10 iterations for fault={fault}, got {}",
            result.iterations
        );
        assert!(
            result.evaluations < 10,
            "expected < 10 evaluations for fault={fault}, got {}",
            result.evaluations
        );
    }
}

#[test]
fn shrink_chaos_failure_minimizes_steps_ops_and_projects() {
    let spec = generate_chaos_workspace(77);
    let steps = generate_chaos_steps(&spec, 77, 6);
    let target_step = 3usize;
    let target_op = steps[target_step].ops[0].clone();

    let (shrunk_spec, report) =
        shrink_chaos_failure(&spec, &steps, target_step, 100, |_cand_spec, cand_steps| {
            cand_steps
                .iter()
                .any(|s| s.ops.iter().any(|op| op == &target_op))
        });
    assert_eq!(report.shrunk_steps, 1);
    assert_eq!(report.shrunk_ops, 1);
    assert_eq!(report.steps[0].ops[0], target_op);
    assert!(shrunk_spec.projects.len() <= spec.projects.len());
}

#[test]
fn chaos_live_smoke_two_scenarios_three_steps() {
    let dad_bin = sibling_dad_bin();
    if !dad_bin.is_file() {
        return;
    }
    let config = ChaosConfig {
        dad_bin,
        node_bin: find_node(),
        scenarios: 2,
        steps_per_scenario: 3,
        base_seed: 1,
        jobs: 2,
        keep_failed: false,
        shrink: false,
        max_sample_failures: 10,
    };
    let summary = run_chaos_sweep(&config).expect("chaos smoke sweep executes cleanly");
    assert_eq!(summary.scenarios_run, 2);
    assert_eq!(summary.steps_executed, 6);
    assert_eq!(
        summary.harness_errors, 0,
        "chaos harness errors: {:#?}",
        summary.sample_failures
    );
    assert_eq!(
        summary.snapshot_parity_checks, 6,
        "expected parity check on every step"
    );
}
