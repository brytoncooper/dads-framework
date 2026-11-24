//! Native task batching: packs ready, uncached tasks with compatible `execution.batch` settings
//! into single process invocations while keeping work strictly within the active job limit.

use super::progress::PreparedTask;
use crate::manifest::TaskExecution;
use std::collections::{BTreeMap, BTreeSet};

pub(super) enum WorkUnit {
    Single(usize),
    Batch {
        indices: Vec<usize>,
        execution: Box<TaskExecution>,
    },
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct BatchSignature {
    executable: String,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    group_key: Option<String>,
    shared_args: Vec<String>,
    max_size: usize,
}

/// Packs up to `slot_budget` work units from `ready`. Tasks whose index appears in
/// `isolated_single` (for example after a multi-task batch failed) always execute standalone.
pub(super) fn pack_work_units(
    prepared: &[PreparedTask],
    ready: &[usize],
    slot_budget: usize,
    isolated_single: &BTreeSet<usize>,
) -> Vec<WorkUnit> {
    if slot_budget == 0 || ready.is_empty() {
        return Vec::new();
    }
    let mut singles = Vec::new();
    let mut groups: BTreeMap<BatchSignature, Vec<(usize, Vec<String>)>> = BTreeMap::new();
    let mut group_order: Vec<BatchSignature> = Vec::new();

    for &index in ready {
        let task = &prepared[index];
        if isolated_single.contains(&index) || task.has_selected_files {
            singles.push(index);
            continue;
        }
        let Some(batch) = &task.execution.batch else {
            singles.push(index);
            continue;
        };
        let split = batch
            .shared_args
            .unwrap_or_else(|| task.execution.args.len().saturating_sub(1))
            .min(task.execution.args.len());
        let shared_args = task.execution.args[..split].to_vec();
        let item_args = task.execution.args[split..].to_vec();
        let signature = BatchSignature {
            executable: task.execution.executable.clone(),
            cwd: task.execution.cwd.clone(),
            env: task.execution.env.clone(),
            group_key: batch.group_key.clone(),
            shared_args,
            max_size: batch.max_size,
        };
        if !groups.contains_key(&signature) {
            group_order.push(BatchSignature {
                executable: signature.executable.clone(),
                cwd: signature.cwd.clone(),
                env: signature.env.clone(),
                group_key: signature.group_key.clone(),
                shared_args: signature.shared_args.clone(),
                max_size: signature.max_size,
            });
        }
        groups
            .entry(signature)
            .or_default()
            .push((index, item_args));
    }

    let mut units = Vec::new();
    for index in singles {
        if units.len() >= slot_budget {
            return units;
        }
        units.push(WorkUnit::Single(index));
    }
    for signature in group_order {
        if units.len() >= slot_budget {
            break;
        }
        let Some(members) = groups.remove(&signature) else {
            continue;
        };
        let chunk_size = signature.max_size.max(2);
        for chunk in members.chunks(chunk_size) {
            if units.len() >= slot_budget {
                break;
            }
            if chunk.len() == 1 {
                units.push(WorkUnit::Single(chunk[0].0));
                continue;
            }
            let mut merged_args = signature.shared_args.clone();
            let mut indices = Vec::with_capacity(chunk.len());
            for (index, item_args) in chunk {
                indices.push(*index);
                merged_args.extend(item_args.iter().cloned());
            }
            units.push(WorkUnit::Batch {
                indices,
                execution: Box::new(TaskExecution {
                    executable: signature.executable.clone(),
                    args: merged_args,
                    cwd: signature.cwd.clone(),
                    shell: false,
                    env: signature.env.clone(),
                    file_narrowing: None,
                    batch: None,
                }),
            });
        }
    }
    units
}
