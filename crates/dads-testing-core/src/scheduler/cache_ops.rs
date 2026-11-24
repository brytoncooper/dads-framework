//! Task preparation, parallel receipt key hashing, and parallel L2 lookups using scoped threads.

use super::progress::{PreparedTask, rebase_file_for_cwd};
use super::receipt_keys::compute_task_receipt_key;
use crate::execute::{TestingError, message};
use crate::manifest::{DeclaredTask, Project, TaskExecution, TestingManifest};
use crate::protocol::PlanResult;
use crate::receipts::{TaskReceiptEntry, TaskReceiptStore};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::thread;

const MAX_CACHE_WORKERS: usize = 16;

struct KeyInput<'a> {
    task: &'a DeclaredTask,
    execution: &'a TaskExecution,
    selected_files: &'a [String],
    should_hash: bool,
}

/// Resolves planned decisions against the manifest in plan order and computes receipt keys in
/// parallel when caching is enabled.
pub(super) fn prepare_tasks(
    manifest: &TestingManifest,
    workspace_root: &Path,
    manifest_file: &Path,
    plan: &PlanResult,
    receipts: Option<&dyn TaskReceiptStore>,
) -> Result<Vec<PreparedTask>, TestingError> {
    let declared: BTreeMap<&str, &DeclaredTask> = manifest
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    let projects_by_id: BTreeMap<&str, &Project> = manifest
        .projects
        .iter()
        .map(|project| (project.id.as_str(), project))
        .collect();
    let planned_ids: BTreeSet<&str> = plan.tasks.iter().map(|d| d.id.as_str()).collect();
    let mut staged = Vec::with_capacity(plan.tasks.len());
    for decision in &plan.tasks {
        let task = declared
            .get(decision.id.as_str())
            .ok_or_else(|| message(format!("Unknown task {}.", decision.id)))?;
        let mut execution = task.execution.clone();
        if !decision.selected_files.is_empty() {
            for file in &decision.selected_files {
                execution
                    .args
                    .push(rebase_file_for_cwd(file, execution.cwd.as_deref()));
            }
        }
        let dependencies = task
            .depends_on
            .iter()
            .filter(|dep| planned_ids.contains(dep.as_str()))
            .cloned()
            .collect();
        staged.push((
            *task,
            execution,
            dependencies,
            decision.decision == "run" && task.cache,
            decision.selected_files.as_slice(),
        ));
    }
    let key_inputs: Vec<KeyInput<'_>> = staged
        .iter()
        .map(
            |(task, execution, _, should_hash, selected_files)| KeyInput {
                task,
                execution,
                selected_files,
                should_hash: *should_hash,
            },
        )
        .collect();
    let keys = compute_keys_parallel(
        receipts,
        manifest,
        &projects_by_id,
        &key_inputs,
        manifest_file,
        workspace_root,
    );
    Ok(staged
        .into_iter()
        .zip(keys)
        .map(
            |((task, execution, dependencies, _, selected), receipt_key)| PreparedTask {
                id: task.id.clone(),
                dependencies,
                execution,
                receipt_key,
                has_selected_files: !selected.is_empty(),
            },
        )
        .collect())
}

fn compute_keys_parallel(
    receipts: Option<&dyn TaskReceiptStore>,
    manifest: &TestingManifest,
    projects_by_id: &BTreeMap<&str, &Project>,
    inputs: &[KeyInput<'_>],
    manifest_file: &Path,
    workspace_root: &Path,
) -> Vec<Option<String>> {
    let Some(store) = receipts else {
        return vec![None; inputs.len()];
    };
    let hashable_count = inputs.iter().filter(|item| item.should_hash).count();
    if hashable_count <= 1 {
        return inputs
            .iter()
            .map(|item| {
                if item.should_hash {
                    compute_task_receipt_key(
                        Some(store),
                        projects_by_id,
                        item.task,
                        item.execution,
                        item.selected_files,
                        manifest_file,
                        workspace_root,
                    )
                } else {
                    None
                }
            })
            .collect();
    }
    let _ = manifest;
    let worker_count = hashable_count.clamp(1, MAX_CACHE_WORKERS);
    let chunk_size = inputs.len().div_ceil(worker_count);
    let mut keys = vec![None; inputs.len()];
    thread::scope(|scope| {
        let mut handles = Vec::new();
        for (chunk_idx, chunk) in inputs.chunks(chunk_size).enumerate() {
            let offset = chunk_idx * chunk_size;
            handles.push(scope.spawn(move || {
                let mut local = Vec::with_capacity(chunk.len());
                for item in chunk {
                    let key = if item.should_hash {
                        compute_task_receipt_key(
                            Some(store),
                            projects_by_id,
                            item.task,
                            item.execution,
                            item.selected_files,
                            manifest_file,
                            workspace_root,
                        )
                    } else {
                        None
                    };
                    local.push(key);
                }
                (offset, local)
            }));
        }
        for handle in handles {
            if let Ok((offset, local)) = handle.join() {
                for (i, key) in local.into_iter().enumerate() {
                    if let Some(slot) = keys.get_mut(offset + i) {
                        *slot = key;
                    }
                }
            }
        }
    });
    keys
}

/// Looks up receipts for all `ready` tasks concurrently (up to 16 scoped threads), preserving the
/// exact input order of `ready`.
pub(super) fn lookup_receipts_parallel(
    store: &dyn TaskReceiptStore,
    prepared: &[PreparedTask],
    ready: &[usize],
) -> Vec<(usize, Option<TaskReceiptEntry>)> {
    if ready.len() <= 1 {
        return ready
            .iter()
            .map(|&index| {
                let entry = prepared[index]
                    .receipt_key
                    .as_deref()
                    .and_then(|key| store.lookup(key));
                (index, entry)
            })
            .collect();
    }
    let worker_count = ready.len().clamp(1, MAX_CACHE_WORKERS);
    let chunk_size = ready.len().div_ceil(worker_count);
    let mut results: Vec<Option<(usize, Option<TaskReceiptEntry>)>> =
        (0..ready.len()).map(|_| None).collect();
    thread::scope(|scope| {
        let mut handles = Vec::new();
        for (chunk_idx, chunk) in ready.chunks(chunk_size).enumerate() {
            let offset = chunk_idx * chunk_size;
            handles.push(scope.spawn(move || {
                let mut local = Vec::with_capacity(chunk.len());
                for &index in chunk {
                    let entry = prepared[index]
                        .receipt_key
                        .as_deref()
                        .and_then(|key| store.lookup(key));
                    local.push((index, entry));
                }
                (offset, local)
            }));
        }
        for handle in handles {
            if let Ok((offset, local)) = handle.join() {
                for (i, item) in local.into_iter().enumerate() {
                    if let Some(slot) = results.get_mut(offset + i) {
                        *slot = Some(item);
                    }
                }
            }
        }
    });
    results.into_iter().flatten().collect()
}
