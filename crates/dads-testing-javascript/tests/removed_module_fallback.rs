use dads_testing_core::graph::DependencyGraph;
use dads_testing_core::{NativeRequest, Operation, execute_request_with_graph};
use dads_testing_javascript::JavaScriptFrontend;
use dads_testing_store::{SnapshotAction, StoreIssueSeverity, load_or_update};
use std::error::Error;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static WORKSPACE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn committed_deletion_retains_graph_and_selects_declared_dependents() -> Result<(), Box<dyn Error>>
{
    assert_removed_module_fallback(false, ChangeState::Committed)
}

#[test]
fn committed_rename_retains_graph_and_selects_both_endpoints() -> Result<(), Box<dyn Error>> {
    assert_removed_module_fallback(true, ChangeState::Committed)
}

#[test]
fn working_deletion_does_not_reuse_a_stale_snapshot() -> Result<(), Box<dyn Error>> {
    assert_removed_module_fallback(false, ChangeState::Unstaged)
}

#[test]
fn working_rename_does_not_reuse_a_stale_snapshot() -> Result<(), Box<dyn Error>> {
    assert_removed_module_fallback(true, ChangeState::Unstaged)
}

#[test]
fn staged_deletion_does_not_reuse_a_stale_snapshot() -> Result<(), Box<dyn Error>> {
    assert_removed_module_fallback(false, ChangeState::Staged)
}

#[test]
fn staged_rename_rebuilds_instead_of_retaining_the_old_module() -> Result<(), Box<dyn Error>> {
    assert_removed_module_fallback(true, ChangeState::Staged)
}

#[test]
fn staged_rename_after_comparison_base_does_not_retain_the_old_module() -> Result<(), Box<dyn Error>>
{
    assert_removed_module_fallback(true, ChangeState::StagedAfterBase)
}

#[derive(PartialEq)]
enum ChangeState {
    Committed,
    Staged,
    StagedAfterBase,
    Unstaged,
}

fn assert_removed_module_fallback(rename: bool, state: ChangeState) -> Result<(), Box<dyn Error>> {
    let workspace = TemporaryWorkspace::create()?;
    let mut request = workspace.request();
    if state == ChangeState::StagedAfterBase {
        request.base = Some(workspace.earlier_base()?);
    }
    let mut frontend = JavaScriptFrontend;
    let baseline = load_or_update(&request, &mut frontend);
    assert_eq!(baseline.action, SnapshotAction::InitialIndex);
    assert!(
        baseline
            .graph
            .ok_or("missing baseline graph")?
            .contains_path("lib/removed.ts")
    );

    let base = match &request.base {
        Some(base) => base.clone(),
        None => workspace.git(&["rev-parse", "HEAD"])?,
    };
    if rename {
        fs::rename(
            workspace.0.join("lib/removed.ts"),
            workspace.0.join("lib/renamed.ts"),
        )?;
    } else {
        fs::remove_file(workspace.0.join("lib/removed.ts"))?;
    }
    request.base = Some(base);
    if state != ChangeState::Unstaged {
        workspace.git(&["add", "--all"])?;
    }
    if state == ChangeState::Committed {
        workspace.git(&[
            "commit",
            "--quiet",
            "--message",
            "remove original module path",
        ])?;
        request.head = Some(workspace.git(&["rev-parse", "HEAD"])?);
        assert!(workspace.git(&["status", "--porcelain"])?.is_empty());
    }

    let stored = load_or_update(&request, &mut frontend);
    assert!(
        stored
            .issues
            .iter()
            .all(|issue| issue.severity != StoreIssueSeverity::Error),
        "{:?}",
        stored.issues
    );
    assert_ne!(stored.action, SnapshotAction::Reused);
    let graph = stored
        .graph
        .ok_or("removed path must not discard current graph evidence")?;
    assert!(!graph.contains_path("lib/removed.ts"));
    assert_eq!(graph.contains_path("lib/renamed.ts"), rename);
    assert!(graph.contains_path("lib/keep.ts"));
    assert!(graph.contains_path("app/index.ts"));

    assert_plan(request, graph, rename)?;

    if state != ChangeState::Committed {
        workspace.restore(rename, state)?;
        let restored = load_or_update(&workspace.request(), &mut frontend);
        assert!(
            restored
                .issues
                .iter()
                .all(|issue| issue.severity != StoreIssueSeverity::Error)
        );
        let graph = restored.graph.ok_or("missing restored graph")?;
        assert!(graph.contains_path("lib/removed.ts"));
        assert!(!graph.contains_path("lib/renamed.ts"));
    }
    Ok(())
}

fn assert_plan(
    request: NativeRequest,
    graph: DependencyGraph,
    rename: bool,
) -> Result<(), Box<dyn Error>> {
    let response = execute_request_with_graph(request, Some(graph));
    assert!(response.ok, "{response:?}");
    let plan = response.result.ok_or("missing plan result")?.plan;
    let mut selected = plan
        .tasks
        .iter()
        .filter(|task| task.decision == "run")
        .map(|task| task.id.as_str())
        .collect::<Vec<_>>();
    selected.sort_unstable();
    assert_eq!(selected, ["app:test", "lib:test"]);
    assert!(!plan.scope.full_fallback);
    assert!(
        plan.scope
            .changed_paths
            .contains(&"lib/removed.ts".to_owned())
    );
    assert_eq!(
        plan.scope
            .changed_paths
            .contains(&"lib/renamed.ts".to_owned()),
        rename
    );
    assert!(
        plan.issues
            .iter()
            .any(|issue| issue.code == "changed-module-unavailable"
                && issue.path.as_deref() == Some("lib/removed.ts")
                && issue.project.as_deref() == Some("lib"))
    );
    assert!(
        !plan
            .issues
            .iter()
            .any(|issue| issue.code == "reachability-frontend-unavailable")
    );

    Ok(())
}

struct TemporaryWorkspace(PathBuf);

impl TemporaryWorkspace {
    fn earlier_base(&self) -> Result<String, Box<dyn Error>> {
        fs::remove_file(self.0.join("lib/removed.ts"))?;
        self.git(&["add", "--all"])?;
        self.git(&[
            "commit",
            "--quiet",
            "--message",
            "base before module existed",
        ])?;
        let base = self.git(&["rev-parse", "HEAD"])?;
        fs::write(self.0.join("lib/removed.ts"), "export const answer = 41;\n")?;
        self.git(&["add", "--all"])?;
        self.git(&["commit", "--quiet", "--message", "add module after base"])?;
        Ok(base)
    }

    fn restore(&self, rename: bool, state: ChangeState) -> Result<(), Box<dyn Error>> {
        // Restore both worktree and index before asking the store to validate its snapshot again.
        if rename {
            fs::rename(self.0.join("lib/renamed.ts"), self.0.join("lib/removed.ts"))?;
        } else {
            fs::write(self.0.join("lib/removed.ts"), "export const answer = 41;\n")?;
        }
        if state != ChangeState::Unstaged {
            self.git(&["add", "--all"])?;
        }
        Ok(())
    }

    fn create() -> Result<Self, Box<dyn Error>> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let sequence = WORKSPACE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "dads-removed-module-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path)?;
        let workspace = Self(path);
        for project in ["lib", "app", "independent"] {
            fs::create_dir(workspace.0.join(project))?;
        }
        fs::write(
            workspace.0.join("lib/removed.ts"),
            "export const answer = 41;\n",
        )?;
        fs::write(workspace.0.join("lib/keep.ts"), "export const keep = 1;\n")?;
        fs::write(
            workspace.0.join("app/index.ts"),
            "import { answer } from '../lib/removed'; import { keep } from '../lib/keep'; export const result = answer + keep;\n",
        )?;
        fs::write(
            workspace.0.join("independent/index.ts"),
            "export const independent = true;\n",
        )?;
        fs::write(workspace.0.join("dads.testing.json"), MANIFEST)?;
        workspace.git(&["init", "--quiet"])?;
        workspace.git(&["config", "user.email", "testing@dads.invalid"])?;
        workspace.git(&["config", "user.name", "Dads Testing"])?;
        workspace.git(&["add", "--all"])?;
        workspace.git(&["commit", "--quiet", "--message", "baseline"])?;
        Ok(workspace)
    }

    fn request(&self) -> NativeRequest {
        NativeRequest {
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
        }
    }

    fn git(&self, arguments: &[&str]) -> Result<String, Box<dyn Error>> {
        let output = Command::new("git")
            .args(arguments)
            .current_dir(&self.0)
            .output()?;
        if !output.status.success() {
            return Err(format!(
                "git {arguments:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )
            .into());
        }
        Ok(String::from_utf8(output.stdout)?.trim().to_owned())
    }
}

impl Drop for TemporaryWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const MANIFEST: &str = r#"{
  "schemaVersion": 1,
  "workspace": {"root": ".", "fullFallback": {"taskIds": ["lib:test", "app:test", "independent:test"]}},
  "projects": [
    {"id": "lib", "root": "lib", "fallbackDependencies": []},
    {"id": "app", "root": "app", "fallbackDependencies": ["lib"]},
    {"id": "independent", "root": "independent", "fallbackDependencies": []}
  ],
  "tasks": [
    {"id": "lib:test", "project": "lib", "kind": "test", "execution": {"executable": "node", "args": ["--version"]}, "dependsOn": [], "impact": {"mode": "reachability"}},
    {"id": "app:test", "project": "app", "kind": "test", "execution": {"executable": "node", "args": ["--version"]}, "dependsOn": [], "impact": {"mode": "reachability"}},
    {"id": "independent:test", "project": "independent", "kind": "test", "execution": {"executable": "node", "args": ["--version"]}, "dependsOn": [], "impact": {"mode": "reachability"}}
  ]
}"#;
