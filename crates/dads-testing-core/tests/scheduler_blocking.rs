use dads_testing_core::{NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, execute_request};
use serde_json::{Value, json};
use std::error::Error;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn failed_prerequisites_block_every_dependent_level() -> Result<(), Box<dyn Error>> {
    for jobs in [1, 4] {
        assert_transitive_blocking(jobs)?;
    }
    Ok(())
}

fn assert_transitive_blocking(jobs: u32) -> Result<(), Box<dyn Error>> {
    let workspace = TemporaryWorkspace::create()?;
    write_manifest(&workspace)?;
    let response = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Run,
        workspace_root: workspace.0.to_string_lossy().into_owned(),
        manifest_path: None,
        base: None,
        head: None,
        all: true,
        task_ids: Vec::new(),
        jobs: Some(jobs),
        cache: false,
    });
    assert!(response.ok, "jobs={jobs}: {response:?}");
    let run = response
        .result
        .ok_or("missing operation result")?
        .run
        .ok_or("missing run result")?;
    assert_eq!(run.exit_code, 1);
    assert_eq!(run.counts.executed, 2);
    assert_eq!(run.counts.failed, 1);
    assert_eq!(run.counts.blocked, 4);
    assert_eq!(run.counts.not_applicable, 0);
    assert_eq!(run.tasks.len(), 6);
    for (id, status, exit_code) in [
        ("fixture:root", "failed", Some(7)),
        ("fixture:first", "blocked", None),
        ("fixture:second", "blocked", None),
        ("fixture:third", "blocked", None),
        ("fixture:fourth", "blocked", None),
        ("fixture:independent", "executed", Some(0)),
    ] {
        let task = run.tasks.iter().find(|task| task.id == id).ok_or(id)?;
        assert_eq!(task.status, status, "jobs={jobs}, task={id}");
        assert_eq!(task.exit_code, exit_code, "jobs={jobs}, task={id}");
    }
    assert_eq!(fs::read_to_string(workspace.0.join("independent"))?, "done");
    assert!(!workspace.0.join("dependent-ran").exists());
    Ok(())
}

fn write_manifest(workspace: &TemporaryWorkspace) -> Result<(), Box<dyn Error>> {
    // Four dependent levels prevent the independent worker's completion from masking the bug.
    let forbidden = "require('node:fs').writeFileSync('dependent-ran', 'ran')";
    let tasks = vec![
        task("fixture:root", &[], "process.exit(7)"),
        task("fixture:first", &["fixture:root"], forbidden),
        task("fixture:second", &["fixture:first"], forbidden),
        task("fixture:third", &["fixture:second"], forbidden),
        task("fixture:fourth", &["fixture:third"], forbidden),
        task(
            "fixture:independent",
            &[],
            "require('node:fs').writeFileSync('independent', 'done')",
        ),
    ];
    let task_ids = tasks.iter().map(|task| &task["id"]).collect::<Vec<_>>();
    let manifest = json!({
        "schemaVersion": 1,
        "workspace": { "root": ".", "fullFallback": { "taskIds": task_ids } },
        "projects": [{ "id": "fixture", "root": "src", "fallbackDependencies": [] }],
        "tasks": tasks,
    });
    fs::create_dir(workspace.0.join("src"))?;
    fs::write(
        workspace.0.join("src/input.js"),
        "export const input = 1;\n",
    )?;
    fs::write(workspace.0.join("dads.testing.json"), manifest.to_string())?;
    Ok(())
}

fn task(id: &str, dependencies: &[&str], script: &str) -> Value {
    json!({
        "id": id,
        "project": "fixture",
        "kind": "custom",
        "execution": { "executable": "node", "args": ["-e", script] },
        "dependsOn": dependencies,
        "impact": { "mode": "always" },
    })
}

struct TemporaryWorkspace(PathBuf);

impl TemporaryWorkspace {
    fn create() -> Result<Self, Box<dyn Error>> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let path = std::env::temp_dir().join(format!(
            "dads-scheduler-blocking-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&path)?;
        Ok(Self(path))
    }
}

impl Drop for TemporaryWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
