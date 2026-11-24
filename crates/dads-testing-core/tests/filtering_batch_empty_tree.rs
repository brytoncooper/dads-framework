use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, TaskShard, execute_request,
};
use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let status = Command::new("git").args(args).current_dir(dir).status()?;
    assert!(status.success(), "git {args:?} failed");
    Ok(())
}

fn make_repo(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!("dads-testing-v07-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("a"))?;
    fs::create_dir_all(dir.join("b"))?;
    fs::create_dir_all(dir.join("c"))?;
    git(&dir, &["init", "-q"])?;
    fs::write(dir.join("a/index.ts"), "export const a = 1;\n")?;
    fs::write(dir.join("b/index.ts"), "export const b = 2;\n")?;
    fs::write(dir.join("c/index.ts"), "export const c = 3;\n")?;
    Ok(dir)
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

#[test]
fn empty_tree_base_resolves_to_all_scope_without_dumping_paths() -> Result<(), Box<dyn Error>> {
    let dir = make_repo("empty-tree")?;
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "workspace": { "root": ".", "fullFallback": { "taskIds": ["a:lint", "b:lint"] } },
        "projects": [
            { "id": "a", "root": "a", "fallbackDependencies": [] },
            { "id": "b", "root": "b", "fallbackDependencies": [] }
        ],
        "tasks": [
            {
                "id": "a:lint", "project": "a", "kind": "lint",
                "execution": { "executable": "true", "args": [] },
                "dependsOn": [], "impact": { "mode": "reachability", "paths": [] }
            },
            {
                "id": "b:lint", "project": "b", "kind": "lint",
                "execution": { "executable": "true", "args": [] },
                "dependsOn": [], "impact": { "mode": "reachability", "paths": [] }
            }
        ]
    });
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    commit_all(&dir)?;

    let resp = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: dir.display().to_string(),
        base: Some("4b825dc642cb6eb9a060e54bf8d69288fbee4904".into()),
        head: Some("HEAD".into()),
        ..NativeRequest::default()
    });
    assert!(resp.ok, "{resp:?}");
    let plan = resp.result.ok_or("missing result")?.plan;
    assert_eq!(plan.scope.kind, "all");
    assert!(plan.scope.full_fallback);
    assert!(plan.scope.changed_paths.is_empty());
    assert_eq!(plan.counts.run, 2);

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn target_project_exclude_and_weighted_sharding_filter_deterministically()
-> Result<(), Box<dyn Error>> {
    let dir = make_repo("filters")?;
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": {
                "taskIds": ["a:lint", "a:test:integration", "b:lint", "b:test:integration", "c:lint"]
            }
        },
        "projects": [
            { "id": "a", "root": "a", "fallbackDependencies": [] },
            { "id": "b", "root": "b", "fallbackDependencies": [] },
            { "id": "c", "root": "c", "fallbackDependencies": [] }
        ],
        "tasks": [
            {
                "id": "a:lint", "project": "a", "kind": "lint",
                "execution": { "executable": "true", "args": [] },
                "dependsOn": [], "impact": { "mode": "always", "paths": [] }
            },
            {
                "id": "a:test:integration", "project": "a", "kind": "test",
                "execution": { "executable": "true", "args": [] },
                "dependsOn": [], "impact": { "mode": "always", "paths": [] }
            },
            {
                "id": "b:lint", "project": "b", "kind": "lint",
                "execution": { "executable": "true", "args": [] },
                "dependsOn": [], "impact": { "mode": "always", "paths": [] }
            },
            {
                "id": "b:test:integration", "project": "b", "kind": "test",
                "execution": { "executable": "true", "args": [] },
                "dependsOn": [], "impact": { "mode": "always", "paths": [] }
            },
            {
                "id": "c:lint", "project": "c", "kind": "lint",
                "execution": { "executable": "true", "args": [] },
                "dependsOn": [], "impact": { "mode": "always", "paths": [] }
            }
        ]
    });
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    commit_all(&dir)?;

    // Filter by target with colon (`test:integration`) and exclude project `b`.
    let resp = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: dir.display().to_string(),
        all: true,
        targets: vec!["test:integration".into()],
        exclude_projects: vec!["b".into()],
        ..NativeRequest::default()
    });
    assert!(resp.ok, "{resp:?}");
    let plan = resp.result.ok_or("missing result")?.plan;
    let ids: Vec<&str> = plan.tasks.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, vec!["a:test:integration"]);

    // Weighted LPT sharding: a=100, b=50, c=50 across 2 shards -> shard 1 gets [a], shard 2 gets [b, c].
    let weights = BTreeMap::from([
        ("a".to_owned(), 100.0),
        ("b".to_owned(), 50.0),
        ("c".to_owned(), 50.0),
    ]);
    let s1 = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: dir.display().to_string(),
        all: true,
        targets: vec!["lint".into()],
        shard: Some(TaskShard { index: 1, total: 2 }),
        shard_weights: weights.clone(),
        ..NativeRequest::default()
    });
    let s2 = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: dir.display().to_string(),
        all: true,
        targets: vec!["lint".into()],
        shard: Some(TaskShard { index: 2, total: 2 }),
        shard_weights: weights,
        ..NativeRequest::default()
    });
    let ids1: Vec<String> = s1
        .result
        .ok_or("s1")?
        .plan
        .tasks
        .into_iter()
        .map(|t| t.id)
        .collect();
    let ids2: Vec<String> = s2
        .result
        .ok_or("s2")?
        .plan
        .tasks
        .into_iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(ids1, vec!["a:lint"]);
    assert_eq!(ids2, vec!["b:lint", "c:lint"]);

    // `--only --task b:lint` on a dirty working tree selects ONLY `b:lint` without git-diff widening
    // or unrelated `impact: always` tasks!
    fs::write(dir.join("a/index.ts"), "export const a = 999;\n")?;
    let only_task = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: dir.display().to_string(),
        only: true,
        task_ids: vec!["b:lint".into()],
        ..NativeRequest::default()
    });
    assert!(only_task.ok, "{only_task:?}");
    let only_plan = only_task.result.ok_or("only_task")?.plan;
    assert_eq!(only_plan.scope.kind, "explicit");
    assert_eq!(only_plan.counts.run, 1);
    let ran: Vec<&str> = only_plan
        .tasks
        .iter()
        .filter(|t| t.decision == "run")
        .map(|t| t.id.as_str())
        .collect();
    assert_eq!(ran, vec!["b:lint"]);

    // `--only --target test:integration --project a` selects ONLY `a:test:integration` without git-diff!
    let only_filtered = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: dir.display().to_string(),
        only: true,
        targets: vec!["test:integration".into()],
        projects: vec!["a".into()],
        ..NativeRequest::default()
    });
    assert!(only_filtered.ok, "{only_filtered:?}");
    let only_f_plan = only_filtered.result.ok_or("only_filtered")?.plan;
    assert_eq!(only_f_plan.scope.kind, "explicit");
    assert_eq!(only_f_plan.counts.run, 1);
    assert_eq!(only_f_plan.tasks[0].id, "a:test:integration");

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn native_task_batching_combines_passing_tasks_and_isolates_failures() -> Result<(), Box<dyn Error>>
{
    let dir = make_repo("batching")?;
    let counter = dir.join(".git/invocations.log");
    let script = dir.join("check.sh");
    fs::write(
        &script,
        format!(
            "#!/bin/sh\necho \"$*\" >> '{}'\nfor arg in \"$@\"; do\n  if [ -f \"$arg/fail\" ]; then\n    echo \"failed:$arg\" >&2\n    exit 1\n  fi\ndone\nexit 0\n",
            counter.display()
        ),
    )?;
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "workspace": { "root": ".", "fullFallback": { "taskIds": ["a:lint", "b:lint", "c:lint"] } },
        "projects": [
            { "id": "a", "root": "a", "fallbackDependencies": [] },
            { "id": "b", "root": "b", "fallbackDependencies": [] },
            { "id": "c", "root": "c", "fallbackDependencies": [] }
        ],
        "tasks": [
            {
                "id": "a:lint", "project": "a", "kind": "lint",
                "execution": {
                    "executable": "sh",
                    "args": ["check.sh", "a"],
                    "batch": { "maxSize": 8, "groupKey": "check", "sharedArgs": 1 }
                },
                "dependsOn": [], "impact": { "mode": "always", "paths": [] }
            },
            {
                "id": "b:lint", "project": "b", "kind": "lint",
                "execution": {
                    "executable": "sh",
                    "args": ["check.sh", "b"],
                    "batch": { "maxSize": 8, "groupKey": "check", "sharedArgs": 1 }
                },
                "dependsOn": [], "impact": { "mode": "always", "paths": [] }
            },
            {
                "id": "c:lint", "project": "c", "kind": "lint",
                "execution": {
                    "executable": "sh",
                    "args": ["check.sh", "c"],
                    "batch": { "maxSize": 8, "groupKey": "check", "sharedArgs": 1 }
                },
                "dependsOn": [], "impact": { "mode": "always", "paths": [] }
            }
        ]
    });
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    commit_all(&dir)?;

    // Happy path: all 3 tasks execute in ONE single process invocation!
    let pass = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Run,
        workspace_root: dir.display().to_string(),
        all: true,
        jobs: Some(4),
        ..NativeRequest::default()
    });
    assert!(pass.ok, "{pass:?}");
    let run = pass
        .result
        .ok_or("missing result")?
        .run
        .ok_or("missing run")?;
    assert_eq!(run.exit_code, 0);
    assert_eq!(run.counts.executed, 3);
    let invocations = fs::read_to_string(&counter)?;
    assert_eq!(
        invocations.lines().count(),
        1,
        "expected 1 batched call, got:\n{invocations}"
    );

    // Failure path: poison only project `b` -> batch fails, scheduler isolates individually ->
    // `a` and `c` PASS while ONLY `b` FAILS!
    fs::write(dir.join("b/fail"), "boom\n")?;
    let fail = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Run,
        workspace_root: dir.display().to_string(),
        all: true,
        jobs: Some(4),
        ..NativeRequest::default()
    });
    assert!(fail.ok, "{fail:?}");
    let run_fail = fail
        .result
        .ok_or("missing result")?
        .run
        .ok_or("missing run")?;
    assert_eq!(run_fail.exit_code, 1);
    assert_eq!(run_fail.counts.failed, 1);
    let statuses: BTreeMap<&str, &str> = run_fail
        .tasks
        .iter()
        .map(|t| (t.id.as_str(), t.status.as_str()))
        .collect();
    assert_eq!(statuses.get("a:lint"), Some(&"executed"));
    assert_eq!(statuses.get("b:lint"), Some(&"failed"));
    assert_eq!(statuses.get("c:lint"), Some(&"executed"));

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}
