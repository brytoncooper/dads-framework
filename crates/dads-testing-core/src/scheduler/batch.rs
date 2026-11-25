//! Native task batching: packs ready, uncached tasks with compatible `execution.batch` settings
//! into single process invocations while keeping work strictly within the active job limit.

use super::progress::PreparedTask;
use super::vitest_batch::VitestBatchMember;
use crate::manifest::{BatchMode, TaskExecution};
use std::collections::{BTreeMap, BTreeSet};

pub(super) enum WorkUnit {
    Single(usize),
    ArgsBatch {
        indices: Vec<usize>,
        execution: Box<TaskExecution>,
    },
    VitestBatch {
        indices: Vec<usize>,
        execution: Box<TaskExecution>,
        members: Vec<VitestBatchMember>,
    },
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ArgsBatchSignature {
    executable: String,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    group_key: Option<String>,
    shared_args: Vec<String>,
    max_size: usize,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct VitestBatchSignature {
    executable: String,
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
    let mut args_groups: BTreeMap<ArgsBatchSignature, Vec<(usize, Vec<String>)>> = BTreeMap::new();
    let mut args_order: Vec<ArgsBatchSignature> = Vec::new();
    let mut vitest_groups: BTreeMap<VitestBatchSignature, Vec<usize>> = BTreeMap::new();
    let mut vitest_order: Vec<VitestBatchSignature> = Vec::new();

    for &index in ready {
        let task = &prepared[index];
        if isolated_single.contains(&index) {
            singles.push(index);
            continue;
        }
        let Some(batch) = &task.execution.batch else {
            singles.push(index);
            continue;
        };
        match batch.effective_mode() {
            BatchMode::Args => {
                if !task.selected_files.is_empty() {
                    singles.push(index);
                    continue;
                }
                let split = batch
                    .shared_args
                    .unwrap_or_else(|| task.execution.args.len().saturating_sub(1))
                    .min(task.execution.args.len());
                let shared_args = task.execution.args[..split].to_vec();
                let item_args = task.execution.args[split..].to_vec();
                let signature = ArgsBatchSignature {
                    executable: task.execution.executable.clone(),
                    cwd: task.execution.cwd.clone(),
                    env: task.execution.env.clone(),
                    group_key: batch.group_key.clone(),
                    shared_args,
                    max_size: batch.max_size,
                };
                if !args_groups.contains_key(&signature) {
                    args_order.push(signature.clone());
                }
                args_groups
                    .entry(signature)
                    .or_default()
                    .push((index, item_args));
            }
            BatchMode::VitestFiles => {
                // Only batch narrowed, cacheable Vitest tasks; non-narrowed or uncached runs stay
                // standalone.
                if task.selected_files.is_empty() || !task.cache {
                    singles.push(index);
                    continue;
                }
                let split = batch
                    .shared_args
                    .unwrap_or(task.base_args_len)
                    .min(task.base_args_len);
                let shared_args = task.execution.args[..split].to_vec();
                let signature = VitestBatchSignature {
                    executable: task.execution.executable.clone(),
                    env: task.execution.env.clone(),
                    group_key: batch.group_key.clone(),
                    shared_args,
                    max_size: batch.max_size,
                };
                if !vitest_groups.contains_key(&signature) {
                    vitest_order.push(signature.clone());
                }
                vitest_groups.entry(signature).or_default().push(index);
            }
        }
    }

    let mut units = Vec::new();
    for index in singles {
        if units.len() >= slot_budget {
            return units;
        }
        units.push(WorkUnit::Single(index));
    }
    pack_args_batches(args_order, &mut args_groups, slot_budget, &mut units);
    pack_vitest_batches(
        prepared,
        vitest_order,
        &mut vitest_groups,
        slot_budget,
        &mut units,
    );
    units
}

fn pack_args_batches(
    order: Vec<ArgsBatchSignature>,
    groups: &mut BTreeMap<ArgsBatchSignature, Vec<(usize, Vec<String>)>>,
    slot_budget: usize,
    units: &mut Vec<WorkUnit>,
) {
    for signature in order {
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
            units.push(WorkUnit::ArgsBatch {
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
}

fn pack_vitest_batches(
    prepared: &[PreparedTask],
    order: Vec<VitestBatchSignature>,
    groups: &mut BTreeMap<VitestBatchSignature, Vec<usize>>,
    slot_budget: usize,
    units: &mut Vec<WorkUnit>,
) {
    for signature in order {
        if units.len() >= slot_budget {
            break;
        }
        let Some(member_indices) = groups.remove(&signature) else {
            continue;
        };
        let chunk_size = signature.max_size.max(2);
        for chunk in member_indices.chunks(chunk_size) {
            if units.len() >= slot_budget {
                break;
            }
            if chunk.len() == 1 {
                units.push(WorkUnit::Single(chunk[0]));
                continue;
            }
            let batch_cwd = shared_cwd_for_chunk(prepared, chunk);
            let members = chunk
                .iter()
                .map(|&index| VitestBatchMember {
                    index,
                    id: prepared[index].id.clone(),
                    selected_files: prepared[index].selected_files.clone(),
                })
                .collect();
            units.push(WorkUnit::VitestBatch {
                indices: chunk.to_vec(),
                execution: Box::new(TaskExecution {
                    executable: signature.executable.clone(),
                    args: signature.shared_args.clone(),
                    cwd: batch_cwd,
                    shell: false,
                    env: signature.env.clone(),
                    file_narrowing: None,
                    batch: None,
                }),
                members,
            });
        }
    }
}

fn shared_cwd_for_chunk(prepared: &[PreparedTask], chunk: &[usize]) -> Option<String> {
    let first = &prepared[chunk[0]].execution.cwd;
    if chunk[1..]
        .iter()
        .all(|&idx| &prepared[idx].execution.cwd == first)
    {
        first.clone()
    } else {
        None
    }
}
