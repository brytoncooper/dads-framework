//! Builds content-hashed receipt keys for planned tasks by resolving a task's owning project
//! root together with all transitive `fallbackDependencies` project roots.
use crate::manifest::{DeclaredTask, TaskExecution, TestingManifest};
use crate::receipts::{TaskReceiptRequest, TaskReceiptStore};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;

pub(super) fn compute_task_receipt_key(
    receipts: Option<&dyn TaskReceiptStore>,
    manifest: &TestingManifest,
    task: &DeclaredTask,
    execution: &TaskExecution,
    selected_files: &[String],
    manifest_file: &Path,
    workspace_root: &Path,
) -> Option<String> {
    let store = receipts?;
    let project_roots = transitive_project_roots(manifest, &task.project);
    let setup_files: &[String] = execution
        .file_narrowing
        .as_ref()
        .map_or(&[], |narrowing| narrowing.setup_files.as_slice());
    store.compute_key(&TaskReceiptRequest {
        task_id: &task.id,
        project: &task.project,
        executable: &execution.executable,
        args: &execution.args,
        cwd: execution.cwd.as_deref(),
        shell: execution.shell,
        setup_files,
        selected_files,
        project_roots: &project_roots,
        manifest_path: manifest_file,
        workspace_root,
    })
}

fn transitive_project_roots(manifest: &TestingManifest, root_project: &str) -> Vec<String> {
    let projects_by_id: BTreeMap<&str, _> = manifest
        .projects
        .iter()
        .map(|project| (project.id.as_str(), project))
        .collect();
    let mut visited = BTreeSet::new();
    let mut queue = VecDeque::new();
    let mut roots = BTreeSet::new();
    if visited.insert(root_project) {
        queue.push_back(root_project);
    }
    while let Some(project_id) = queue.pop_front() {
        let Some(project) = projects_by_id.get(project_id) else {
            continue;
        };
        roots.insert(project.root.clone());
        for dep in &project.fallback_dependencies {
            if visited.insert(dep.as_str()) {
                queue.push_back(dep.as_str());
            }
        }
    }
    roots.into_iter().collect()
}
