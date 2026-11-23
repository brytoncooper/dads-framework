use dads_testing_core::{
    NativeRequest, Operation, PlanResult, TaskCause, TaskDecision, execute_request,
};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::error::Error;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static WORKSPACE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn explains_matching_inputs_outside_the_task_project() -> Result<(), Box<dyn Error>> {
    let workspace = TemporaryWorkspace::create()?;
    fs::write(workspace.0.join("tools/input.txt"), "changed input\n")?;
    fs::write(
        workspace.0.join("tools-extra/input.txt"),
        "unmatched input\n",
    )?;
    let plan = workspace.plan()?;
    assert!(!plan.scope.full_fallback);
    let selected = plan
        .tasks
        .iter()
        .filter(|task| task.decision == "run")
        .map(|task| task.id.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        selected,
        BTreeSet::from(["app:prepare", "app:test", "root:check"])
    );

    let selected_input = decision(&plan, "app:test")?;
    assert_eq!(selected_input.reason, "changed-file-input");
    assert_eq!(selected_input.confidence, "explicit");
    assert!(!selected_input.widened);
    assert_eq!(
        selected_input.causes,
        vec![TaskCause::ChangedPath {
            path: "tools/input.txt".to_owned(),
        }]
    );

    let prerequisite = decision(&plan, "app:prepare")?;
    assert_eq!(prerequisite.reason, "selected-prerequisite");
    assert_eq!(
        prerequisite.causes,
        vec![TaskCause::PrerequisiteOf {
            task_id: "app:test".to_owned(),
        }]
    );
    assert_unaffected(decision(&plan, "app:sibling")?);
    Ok(())
}

#[test]
fn retains_proven_unaffected_explanations_without_changes() -> Result<(), Box<dyn Error>> {
    let workspace = TemporaryWorkspace::create()?;
    let plan = workspace.plan()?;
    assert!(!plan.scope.full_fallback);
    assert!(plan.scope.changed_paths.is_empty());
    assert_eq!(plan.counts.run, 0);
    for task in &plan.tasks {
        assert_unaffected(task);
    }
    Ok(())
}

fn assert_unaffected(task: &TaskDecision) {
    assert_eq!(task.decision, "skip-proven-unaffected");
    assert_eq!(task.reason, "proven-unaffected");
    assert_eq!(task.confidence, "proven");
    assert!(!task.widened);
    assert!(task.causes.is_empty());
}

fn decision<'a>(plan: &'a PlanResult, id: &str) -> Result<&'a TaskDecision, Box<dyn Error>> {
    plan.tasks
        .iter()
        .find(|task| task.id == id)
        .ok_or_else(|| format!("missing task {id}").into())
}

struct TemporaryWorkspace(PathBuf);

impl TemporaryWorkspace {
    fn create() -> Result<Self, Box<dyn Error>> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let sequence = WORKSPACE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "dads-changed-file-explanation-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path)?;
        let workspace = Self(path);
        for directory in ["app", "tools", "tools-extra"] {
            fs::create_dir(workspace.0.join(directory))?;
            fs::write(workspace.0.join(directory).join("input.txt"), "baseline\n")?;
        }
        let tasks = vec![
            task("root:check", "root", &[], json!({"mode": "project"})),
            task(
                "app:prepare",
                "app",
                &[],
                json!({"mode": "changed-files", "paths": ["app"]}),
            ),
            task(
                "app:test",
                "app",
                &["app:prepare"],
                json!({"mode": "changed-files", "paths": ["tools", "tools/input.txt"]}),
            ),
            task("app:sibling", "app", &[], json!({"mode": "project"})),
        ];
        let task_ids = tasks.iter().map(|task| &task["id"]).collect::<Vec<_>>();
        let manifest = json!({
            "schemaVersion": 1,
            "workspace": {"root": ".", "fullFallback": {"taskIds": task_ids}},
            "projects": [
                {"id": "root", "root": ".", "fallbackDependencies": []},
                {"id": "app", "root": "app", "fallbackDependencies": []},
            ],
            "tasks": tasks,
        });
        fs::write(workspace.0.join("dads.testing.json"), manifest.to_string())?;
        workspace.git(&["init", "--quiet"])?;
        workspace.git(&["config", "user.email", "testing@dads.invalid"])?;
        workspace.git(&["config", "user.name", "Dads Testing"])?;
        workspace.git(&["add", "--all"])?;
        workspace.git(&["commit", "--quiet", "--message", "baseline"])?;
        Ok(workspace)
    }

    fn plan(&self) -> Result<PlanResult, Box<dyn Error>> {
        let response = execute_request(NativeRequest {
            schema_version: 1,
            operation: Operation::Plan,
            workspace_root: self.0.to_string_lossy().into_owned(),
            manifest_path: None,
            base: None,
            head: None,
            all: false,
            task_ids: Vec::new(),
            jobs: None,
            cache: false,
        });
        assert!(response.ok, "{response:?}");
        Ok(response.result.ok_or("missing plan result")?.plan)
    }

    fn git(&self, arguments: &[&str]) -> Result<(), Box<dyn Error>> {
        let output = Command::new("git")
            .args(arguments)
            .current_dir(&self.0)
            .output()?;
        if !output.status.success() {
            return Err(format!("git failed: {}", String::from_utf8_lossy(&output.stderr)).into());
        }
        Ok(())
    }
}

impl Drop for TemporaryWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn task(id: &str, project: &str, depends_on: &[&str], impact: Value) -> Value {
    json!({
        "id": id,
        "project": project,
        "kind": "test",
        "execution": {"executable": "node", "args": ["--version"]},
        "dependsOn": depends_on,
        "impact": impact,
    })
}
