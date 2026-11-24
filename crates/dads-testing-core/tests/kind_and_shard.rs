use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, TaskShard, execute_request,
};
use serde_json::json;
use std::collections::BTreeSet;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let status = Command::new("git").args(args).current_dir(dir).status()?;
    assert!(status.success(), "git {args:?} failed");
    Ok(())
}

fn make_multi_kind_repo(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!(
        "dads-testing-kind-shard-{name}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("src"))?;
    git(&dir, &["init", "-q"])?;

    let manifest = json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": { "taskIds": ["a:test", "b:test", "c:test", "a:lint", "a:typecheck"] }
        },
        "projects": [{ "id": "a", "root": "src", "fallbackDependencies": [] }],
        "tasks": [
            { "id": "a:test", "project": "a", "kind": "test", "execution": { "executable": "true", "args": [] }, "dependsOn": ["a:lint"], "impact": { "mode": "always", "paths": [] } },
            { "id": "b:test", "project": "a", "kind": "test", "execution": { "executable": "true", "args": [] }, "dependsOn": [], "impact": { "mode": "always", "paths": [] } },
            { "id": "c:test", "project": "a", "kind": "test", "execution": { "executable": "true", "args": [] }, "dependsOn": [], "impact": { "mode": "always", "paths": [] } },
            { "id": "a:lint", "project": "a", "kind": "lint", "execution": { "executable": "true", "args": [] }, "dependsOn": [], "impact": { "mode": "always", "paths": [] } },
            { "id": "a:typecheck", "project": "a", "kind": "typecheck", "execution": { "executable": "true", "args": [] }, "dependsOn": [], "impact": { "mode": "always", "paths": [] } }
        ]
    });
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    fs::write(dir.join("src/a.ts"), "export const a = 1;\n")?;
    git(&dir, &["add", "."])?;
    git(
        &dir,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@e.invalid",
            "commit",
            "-qm",
            "base",
        ],
    )?;
    Ok(dir)
}

#[test]
fn kind_filter_and_sharding_partition_selected_tasks_and_run_without_deadlock()
-> Result<(), Box<dyn Error>> {
    let dir = make_multi_kind_repo("partition")?;

    let mut union = BTreeSet::new();
    for shard_index in 1..=2 {
        let req = NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: dir.display().to_string(),
            manifest_path: None,
            base: None,
            head: None,
            all: true,
            task_ids: Vec::new(),
            task_kinds: vec!["test".to_owned()],
            shard: Some(TaskShard {
                index: shard_index,
                total: 2,
            }),
            jobs: Some(2),
            cache: false,
            remote_cache_url: None,
        };
        let resp = execute_request(req);
        assert!(resp.ok, "{resp:?}");
        let res = resp.result.ok_or("missing result")?;
        let run = res.run.ok_or("missing run")?;
        assert_eq!(run.exit_code, 0);
        for task in res.plan.tasks {
            assert!(task.id.ends_with(":test"), "non-test task leaked: {}", task.id);
            assert!(
                union.insert(task.id.clone()),
                "duplicate task across shards: {}",
                task.id
            );
        }
    }
    assert_eq!(
        union,
        BTreeSet::from([
            "a:test".to_owned(),
            "b:test".to_owned(),
            "c:test".to_owned(),
        ])
    );

    // Invalid shard fails closed.
    let bad = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: dir.display().to_string(),
        manifest_path: None,
        base: None,
        head: None,
        all: true,
        task_ids: Vec::new(),
        task_kinds: Vec::new(),
        shard: Some(TaskShard { index: 3, total: 2 }),
        jobs: None,
        cache: false,
        remote_cache_url: None,
    });
    assert!(!bad.ok);

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}
