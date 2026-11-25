use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, TaskShard, execute_request,
};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let status = Command::new("git").args(args).current_dir(dir).status()?;
    assert!(status.success(), "git {args:?} failed");
    Ok(())
}

fn commit_all(dir: &Path) -> Result<(), Box<dyn Error>> {
    git(dir, &["add", "."])?;
    git(
        dir,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@e.invalid",
            "commit",
            "-qm",
            "init",
        ],
    )
}

fn make_multi_project_repo(
    name: &str,
    projects: &[&str],
    targets: &[&str],
    log_file: Option<&Path>,
) -> Result<PathBuf, Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!(
        "dads-testing-shard-plan-{name}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir)?;
    git(&dir, &["init", "-q"])?;

    let mut project_defs = Vec::new();
    let mut task_defs = Vec::new();
    let mut full_fallback = Vec::new();

    for project in projects {
        fs::create_dir_all(dir.join(project))?;
        fs::write(
            dir.join(project).join("index.ts"),
            format!("export const {project} = 1;\n"),
        )?;
        project_defs.push(json!({
            "id": project,
            "root": project,
            "fallbackDependencies": []
        }));
        for target in targets {
            let task_id = format!("{project}:{target}");
            full_fallback.push(task_id.clone());
            let execution = match log_file {
                Some(log_path) => json!({
                    "executable": "sh",
                    "args": ["-c", format!("echo '{task_id}' >> '{}'", log_path.display())]
                }),
                None => json!({ "executable": "true", "args": [] }),
            };
            task_defs.push(json!({
                "id": task_id,
                "project": project,
                "kind": if *target == "test" { "test" } else { "lint" },
                "execution": execution,
                "dependsOn": [],
                "impact": { "mode": "project", "paths": [] }
            }));
        }
    }

    let manifest = json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": { "taskIds": full_fallback }
        },
        "projects": project_defs,
        "tasks": task_defs
    });
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    commit_all(&dir)?;
    Ok(dir)
}

#[test]
fn unweighted_sharding_groups_targets_by_project_and_partitions_completely()
-> Result<(), Box<dyn Error>> {
    let projects = ["alpha", "beta", "gamma", "delta"];
    let targets = ["lint", "lint-typed"];
    let dir = make_multi_project_repo("unweighted-grouped", &projects, &targets, None)?;

    // Without --shard, shard metadata is omitted.
    let unsharded = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: dir.display().to_string(),
        all: true,
        ..NativeRequest::default()
    });
    assert!(unsharded.ok, "{unsharded:?}");
    let unsharded_plan = unsharded.result.ok_or("missing result")?.plan;
    assert!(unsharded_plan.shard.is_none());

    let total_shards = 3_u32;
    let mut seen_tasks = BTreeSet::new();
    let mut seen_projects = BTreeSet::new();
    let mut sum_selected_projects = 0_usize;
    let mut sum_selected_tasks = 0_usize;
    let mut sum_shard_weight = 0.0_f64;

    for shard_index in 1..=total_shards {
        let resp = execute_request(NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Plan,
            workspace_root: dir.display().to_string(),
            all: true,
            shard: Some(TaskShard {
                index: shard_index,
                total: total_shards,
            }),
            ..NativeRequest::default()
        });
        assert!(resp.ok, "{resp:?}");
        let plan = resp.result.ok_or("missing result")?.plan;
        let meta = plan.shard.ok_or("missing shard metadata")?;
        assert_eq!(meta.index, shard_index);
        assert_eq!(meta.total, total_shards);
        assert!(!meta.weighted);
        assert_eq!(meta.total_projects, 4);
        assert_eq!(meta.total_runnable_tasks, 8);
        assert_eq!(meta.selected_runnable_tasks, plan.counts.run);

        sum_selected_projects += meta.selected_projects;
        sum_selected_tasks += meta.selected_runnable_tasks;
        sum_shard_weight += meta.shard_weight;

        // Every project appearing on this shard must have BOTH lint and lint-typed on this shard.
        let mut by_project: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for task in &plan.tasks {
            if task.decision == "run" {
                assert!(
                    seen_tasks.insert(task.id.clone()),
                    "duplicate task across shards: {}",
                    task.id
                );
                by_project
                    .entry(task.project.clone())
                    .or_default()
                    .push(task.id.clone());
            }
        }
        assert_eq!(by_project.len(), meta.selected_projects);
        for (project, ids) in &by_project {
            assert!(
                seen_projects.insert(project.clone()),
                "project split across shards: {project}"
            );
            assert_eq!(
                ids.len(),
                2,
                "project {project} must keep lint and lint-typed together, got {ids:?}"
            );
        }
    }

    assert_eq!(seen_tasks.len(), 8);
    assert_eq!(seen_projects.len(), 4);
    assert_eq!(sum_selected_projects, 4);
    assert_eq!(sum_selected_tasks, 8);
    assert!((sum_shard_weight - 8.0).abs() < f64::EPSILON);

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn weighted_lpt_sharding_balances_heavy_projects_and_breaks_ties_alphabetically()
-> Result<(), Box<dyn Error>> {
    let projects = ["heavy", "med_a", "med_b", "light_a", "light_b"];
    let dir = make_multi_project_repo("weighted-lpt", &projects, &["test"], None)?;

    // LPT across 3 shards:
    //   heavy(100)  -> shard 1 (load 100)
    //   med_a(40)   -> shard 2 (load 40)
    //   med_b(40)   -> shard 3 (load 40)
    //   light_a(20) -> shard 2 (load 60)
    //   light_b(20) -> shard 3 (load 60)
    let weights = BTreeMap::from([
        ("heavy".to_owned(), 100.0),
        ("med_a".to_owned(), 40.0),
        ("med_b".to_owned(), 40.0),
        ("light_a".to_owned(), 20.0),
        ("light_b".to_owned(), 20.0),
    ]);

    let expected: [(u32, &[&str], f64); 3] = [
        (1, &["heavy:test"], 100.0),
        (2, &["light_a:test", "med_a:test"], 60.0),
        (3, &["light_b:test", "med_b:test"], 60.0),
    ];

    for (index, expected_ids, expected_weight) in expected {
        let resp = execute_request(NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Plan,
            workspace_root: dir.display().to_string(),
            all: true,
            shard: Some(TaskShard { index, total: 3 }),
            shard_weights: weights.clone(),
            ..NativeRequest::default()
        });
        assert!(resp.ok, "{resp:?}");
        let plan = resp.result.ok_or("missing result")?.plan;
        let mut actual_ids: Vec<String> = plan
            .tasks
            .iter()
            .filter(|t| t.decision == "run")
            .map(|t| t.id.clone())
            .collect();
        actual_ids.sort();
        let expected_vec: Vec<String> = expected_ids.iter().map(|s| (*s).to_owned()).collect();
        assert_eq!(actual_ids, expected_vec, "shard {index}/3 mismatch");

        let meta = plan.shard.ok_or("missing shard metadata")?;
        assert!(meta.weighted);
        assert_eq!(meta.index, index);
        assert_eq!(meta.total, 3);
        assert!((meta.shard_weight - expected_weight).abs() < f64::EPSILON);
        assert!((meta.total_weight - 220.0).abs() < f64::EPSILON);
    }

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn run_with_plan_file_reuses_plan_without_git_diff_and_supports_sharding()
-> Result<(), Box<dyn Error>> {
    let projects = ["alpha", "beta", "gamma"];
    let targets = ["lint", "lint-typed"];
    let log_path = std::env::temp_dir().join(format!(
        "dads-testing-plan-file-exec-{}.log",
        std::process::id()
    ));
    let _ = fs::remove_file(&log_path);

    let dir = make_multi_project_repo("plan-file", &projects, &targets, Some(&log_path))?;

    // Touch only alpha & beta before planning; gamma is proven unaffected.
    fs::write(dir.join("alpha/index.ts"), "export const alpha = 2;\n")?;
    fs::write(dir.join("beta/index.ts"), "export const beta = 2;\n")?;

    let planned = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: dir.display().to_string(),
        ..NativeRequest::default()
    });
    assert!(planned.ok, "{planned:?}");
    let plan = planned.result.ok_or("missing plan")?.plan;
    assert_eq!(plan.counts.run, 4);
    assert_eq!(plan.counts.skip_proven_unaffected, 2);

    // Save both the CLI envelope format and raw PlanResult JSON outside the repo working tree.
    let plan_dir = std::env::temp_dir().join(format!(
        "dads-testing-plan-file-artifacts-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&plan_dir);
    fs::create_dir_all(&plan_dir)?;
    let envelope_path = plan_dir.join("ci-plan-envelope.json");
    let envelope = json!({
        "schemaVersion": 1,
        "ok": true,
        "result": plan
    });
    fs::write(&envelope_path, serde_json::to_string_pretty(&envelope)?)?;

    let raw_plan_path = plan_dir.join("ci-plan-raw.json");
    fs::write(&raw_plan_path, serde_json::to_string_pretty(&plan)?)?;

    let weights = BTreeMap::from([("alpha".to_owned(), 200.0), ("beta".to_owned(), 50.0)]);
    for (shard_index, file_path) in [(1_u32, &envelope_path), (2_u32, &raw_plan_path)] {
        let resp = execute_request(NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: dir.display().to_string(),
            plan_file: Some(file_path.display().to_string()),
            shard: Some(TaskShard {
                index: shard_index,
                total: 2,
            }),
            shard_weights: weights.clone(),
            ..NativeRequest::default()
        });
        assert!(resp.ok, "shard {shard_index} failed: {resp:?}");
        let res = resp.result.ok_or("missing run result")?;
        let run = res.run.ok_or("missing run")?;
        assert_eq!(run.exit_code, 0);
        assert_eq!(run.counts.executed, 2);
        let meta = res.plan.shard.ok_or("missing shard metadata")?;
        assert_eq!(meta.index, shard_index);
        assert_eq!(meta.total, 2);
        assert_eq!(meta.total_projects, 2);
        assert_eq!(meta.selected_projects, 1);
    }

    assert_stale_plan_refused(&dir, &envelope_path)?;
    let _ = fs::remove_dir_all(&plan_dir);

    let executed_lines: Vec<String> = fs::read_to_string(&log_path)?
        .lines()
        .map(str::to_owned)
        .collect();
    let executed_set: BTreeSet<String> = executed_lines.iter().cloned().collect();
    assert_eq!(
        executed_lines.len(),
        4,
        "expected exactly 4 task executions across 2 shards, got {executed_lines:?}"
    );
    assert_eq!(
        executed_set,
        BTreeSet::from([
            "alpha:lint".to_owned(),
            "alpha:lint-typed".to_owned(),
            "beta:lint".to_owned(),
            "beta:lint-typed".to_owned(),
        ])
    );

    let _ = fs::remove_file(&log_path);
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

fn assert_stale_plan_refused(dir: &Path, plan_file: &Path) -> Result<(), Box<dyn Error>> {
    fs::write(dir.join("gamma/index.ts"), "export const gamma = 999;\n")?;
    let stale_after_edit = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Run,
        workspace_root: dir.display().to_string(),
        plan_file: Some(plan_file.display().to_string()),
        ..NativeRequest::default()
    });
    assert!(
        !stale_after_edit.ok,
        "stale --plan-file must be refused after post-plan edits: {stale_after_edit:?}"
    );
    assert!(
        stale_after_edit
            .error
            .as_deref()
            .is_some_and(|msg| msg.contains("stale")),
        "expected stale error message, got: {:?}",
        stale_after_edit.error
    );
    Ok(())
}

#[test]
fn run_with_plan_file_refuses_invalid_combinations_and_stale_tasks() -> Result<(), Box<dyn Error>> {
    let dir = make_multi_project_repo("plan-file-refusals", &["alpha"], &["lint"], None)?;
    let envelope_path = dir.join("ci-plan-envelope.json");
    fs::write(
        &envelope_path,
        serde_json::to_string(&json!({
            "schemaVersion": 1,
            "ok": true,
            "result": {
                "schemaVersion": 1,
                "scope": { "kind": "all", "changedPaths": [], "fullFallback": true },
                "tasks": [{
                    "id": "alpha:lint",
                    "decision": "run",
                    "reason": "all",
                    "confidence": "proven",
                    "widened": false,
                    "project": "alpha"
                }],
                "issues": [],
                "complete": true,
                "counts": { "run": 1, "skipProvenUnaffected": 0 }
            }
        }))?,
    )?;

    let on_plan = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: dir.display().to_string(),
        plan_file: Some(envelope_path.display().to_string()),
        ..NativeRequest::default()
    });
    assert!(!on_plan.ok);

    let with_all = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Run,
        workspace_root: dir.display().to_string(),
        all: true,
        plan_file: Some(envelope_path.display().to_string()),
        ..NativeRequest::default()
    });
    assert!(!with_all.ok);

    let failed_envelope_path = dir.join("failed-plan.json");
    fs::write(
        &failed_envelope_path,
        serde_json::to_string(&json!({
            "schemaVersion": 1,
            "ok": false,
            "error": "boom"
        }))?,
    )?;
    let failed_resp = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Run,
        workspace_root: dir.display().to_string(),
        plan_file: Some(failed_envelope_path.display().to_string()),
        ..NativeRequest::default()
    });
    assert!(!failed_resp.ok);

    let stale_plan_path = dir.join("stale-plan.json");
    fs::write(
        &stale_plan_path,
        serde_json::to_string(&json!({
            "schemaVersion": 1,
            "scope": { "kind": "all", "changedPaths": [], "fullFallback": true },
            "tasks": [{
                "id": "ghost:lint",
                "decision": "run",
                "reason": "all",
                "confidence": "proven",
                "widened": false,
                "project": "ghost"
            }],
            "issues": [],
            "complete": true,
            "counts": { "run": 1, "skipProvenUnaffected": 0 }
        }))?,
    )?;
    let stale_resp = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Run,
        workspace_root: dir.display().to_string(),
        plan_file: Some(stale_plan_path.display().to_string()),
        ..NativeRequest::default()
    });
    assert!(!stale_resp.ok);

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}
