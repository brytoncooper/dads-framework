//! Running a plan: the concurrency bound, prerequisite order, blocking, and the absence of any
//! result reuse between runs.
use super::support::{
    assert_run_status, request, run_request, run_task, shell_literal, testing_repository,
    write_run_manifest,
};
use crate::execute_request;
use std::fs::{remove_dir_all, write};
use std::path::Path;

/// A task body that records the highest number of workers ever running at once, in the
/// repository's `maximum` file. Both concurrency tests read that number back.
fn concurrency_probe(repository: &Path) -> String {
    let lock = shell_literal(&repository.join("scheduler.lock").display().to_string());
    let running = shell_literal(&repository.join("running").display().to_string());
    let maximum = shell_literal(&repository.join("maximum").display().to_string());
    write(repository.join("running"), "0\n").expect("running counter must be writable");
    write(repository.join("maximum"), "0\n").expect("maximum counter must be writable");
    format!(
        "while ! mkdir {lock} 2>/dev/null; do sleep 0.01; done; current=$(cat {running}); current=$((current + 1)); printf '%s\\n' \"$current\" > {running}; previous=$(cat {maximum}); if [ \"$current\" -gt \"$previous\" ]; then printf '%s\\n' \"$current\" > {maximum}; fi; rmdir {lock}; sleep 0.12; while ! mkdir {lock} 2>/dev/null; do sleep 0.01; done; current=$(cat {running}); printf '%s\\n' \"$((current - 1))\" > {running}; rmdir {lock}"
    )
}

#[test]
fn run_respects_the_requested_maximum_concurrency() {
    let repository = testing_repository();
    let script = concurrency_probe(&repository);
    write_run_manifest(
        &repository,
        vec![
            run_task("fixture:first", &[], &script),
            run_task("fixture:second", &[], &script),
            run_task("fixture:third", &[], &script),
            run_task("fixture:fourth", &[], &script),
        ],
    );

    let response = execute_request(run_request(&repository, Some(2)));
    assert!(response.ok, "{response:?}");
    let run = response
        .result
        .expect("run result must be present")
        .run
        .expect("run operation must include results");
    assert_eq!(run.counts.executed, 4);
    assert_eq!(run.counts.failed, 0);
    assert_eq!(run.counts.blocked, 0);
    assert_eq!(
        std::fs::read_to_string(repository.join("maximum"))
            .expect("maximum must be readable")
            .trim(),
        "2"
    );
    remove_dir_all(repository).expect("temporary repository must be removable");
}

/// Without a requested limit the run uses the protocol's fixed default of four workers, so the
/// same manifest behaves the same way on every machine.
#[test]
fn run_uses_four_workers_when_no_limit_is_requested() {
    let repository = testing_repository();
    let script = concurrency_probe(&repository);
    write_run_manifest(
        &repository,
        (1..=8)
            .map(|index| run_task(&format!("fixture:task-{index}"), &[], &script))
            .collect(),
    );

    let response = execute_request(run_request(&repository, None));

    assert!(response.ok, "{response:?}");
    let run = response
        .result
        .expect("run result must be present")
        .run
        .expect("run operation must include results");
    assert_eq!(run.counts.executed, 8);
    assert_eq!(
        std::fs::read_to_string(repository.join("maximum"))
            .expect("maximum must be readable")
            .trim(),
        "4"
    );
    remove_dir_all(repository).expect("temporary repository must be removable");
}

/// The scheduler's own bound. `plan.rs` refuses a zero limit before a run ever gets here, so this
/// asserts the guard directly; `tests/request_refusals.rs` holds the planner's matching refusal.
#[test]
fn the_scheduler_refuses_a_zero_job_limit() {
    let repository = testing_repository();
    write_run_manifest(&repository, vec![run_task("fixture:only", &[], "true")]);
    let response = execute_request(request(&repository, Vec::new()));
    assert!(response.ok, "{response:?}");
    let plan = response.result.expect("plan result must be present").plan;
    let manifest = crate::manifest::load_manifest(&repository.join("dads.testing.json"))
        .expect("the fixture manifest must load");

    let manifest_file = repository.join("dads.testing.json");
    let refusal =
        crate::scheduler::run_plan(&manifest, &repository, &manifest_file, &plan, Some(0), None)
            .expect_err("a zero job limit must be refused");

    assert_eq!(refusal.to_string(), "jobs must be greater than zero.");
    assert!(
        crate::scheduler::run_plan(&manifest, &repository, &manifest_file, &plan, Some(1), None)
            .is_ok()
    );
    remove_dir_all(repository).expect("temporary repository must be removable");
}

#[test]
fn run_waits_for_prerequisites_and_returns_manifest_topological_order() {
    let repository = testing_repository();
    let marker = shell_literal(&repository.join("prepared").display().to_string());
    write_run_manifest(
        &repository,
        vec![
            run_task("fixture:prepare", &[], &format!("printf ready > {marker}")),
            run_task(
                "fixture:test",
                &["fixture:prepare"],
                &format!("test -f {marker}"),
            ),
        ],
    );

    let response = execute_request(run_request(&repository, Some(2)));
    assert!(response.ok, "{response:?}");
    let run = response
        .result
        .expect("run result must be present")
        .run
        .expect("run operation must include results");
    assert_eq!(
        run.tasks
            .iter()
            .map(|task| task.id.as_str())
            .collect::<Vec<_>>(),
        vec!["fixture:prepare", "fixture:test"]
    );
    assert!(run.tasks.iter().all(|task| task.status == "executed"));
    remove_dir_all(repository).expect("temporary repository must be removable");
}

#[test]
fn run_continues_independent_work_and_blocks_failed_dependents() {
    let repository = testing_repository();
    let marker = shell_literal(
        &repository
            .join("independent-finished")
            .display()
            .to_string(),
    );
    write_run_manifest(
        &repository,
        vec![
            run_task("fixture:fails", &[], "exit 7"),
            run_task("fixture:blocked", &["fixture:fails"], "exit 99"),
            run_task(
                "fixture:independent",
                &[],
                &format!("printf done > {marker}"),
            ),
            run_task(
                "fixture:dependent",
                &["fixture:independent"],
                &format!("test -f {marker}"),
            ),
        ],
    );

    let response = execute_request(run_request(&repository, Some(2)));
    assert!(response.ok, "{response:?}");
    let run = response
        .result
        .expect("run result must be present")
        .run
        .expect("run operation must include results");
    assert_eq!(run.exit_code, 1);
    assert_eq!(run.counts.executed, 3);
    assert_eq!(run.counts.failed, 1);
    assert_eq!(run.counts.blocked, 1);
    assert_run_status(&run, "fixture:fails", "failed");
    assert_run_status(&run, "fixture:blocked", "blocked");
    assert_run_status(&run, "fixture:independent", "executed");
    assert_run_status(&run, "fixture:dependent", "executed");
    remove_dir_all(repository).expect("temporary repository must be removable");
}

#[test]
fn run_does_not_reuse_a_previous_task_result() {
    let repository = testing_repository();
    let executions = shell_literal(&repository.join("executions").display().to_string());
    write_run_manifest(
        &repository,
        vec![run_task(
            "fixture:repeat",
            &[],
            &format!("printf 'run\\n' >> {executions}"),
        )],
    );

    let first = execute_request(run_request(&repository, Some(1)));
    let second = execute_request(run_request(&repository, Some(1)));
    assert!(first.ok, "{first:?}");
    assert!(second.ok, "{second:?}");
    assert_eq!(
        std::fs::read_to_string(repository.join("executions"))
            .expect("execution log must be readable")
            .lines()
            .count(),
        2
    );
    remove_dir_all(repository).expect("temporary repository must be removable");
}
