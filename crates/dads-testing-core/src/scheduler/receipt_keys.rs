//! Builds content-hashed receipt keys strictly from the planner-computed `TaskCacheInputs`.
//!
//! Fails closed (`None`) whenever `cache_inputs` is absent or marks the task non-cacheable so the
//! scheduler never invents an independent dependency closure.
use crate::manifest::{DeclaredTask, TaskExecution};
use crate::protocol::TaskCacheInputs;
use crate::receipts::{TaskReceiptRequest, TaskReceiptStore};
use std::path::Path;

pub(super) fn compute_task_receipt_key(
    receipts: Option<&dyn TaskReceiptStore>,
    task: &DeclaredTask,
    execution: &TaskExecution,
    selected_files: &[String],
    cache_inputs: Option<&TaskCacheInputs>,
    manifest_file: &Path,
    workspace_root: &Path,
) -> Option<String> {
    let store = receipts?;
    let inputs = cache_inputs.filter(|inputs| inputs.cacheable)?;
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
        env: &execution.env,
        setup_files,
        selected_files,
        project_roots: &inputs.project_roots,
        impact_paths: &inputs.impact_paths,
        extra_files: &inputs.extra_files,
        manifest_path: manifest_file,
        workspace_root,
    })
}
