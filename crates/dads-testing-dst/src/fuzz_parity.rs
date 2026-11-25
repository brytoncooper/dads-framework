//! Cold-vs-incremental `.git/dads-testing/graph-v*.json` snapshot parity checker for chaos DST.

use crate::dad_client::{NativeRequestPayload, PlannedTaskView, invoke_dad};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

type PlanSignature = BTreeMap<String, (String, Vec<String>)>;

pub enum ParityCheckOutcome {
    Matched,
    Diverged { kind: &'static str, detail: String },
}

pub fn check_cold_vs_incremental_parity(
    dad_bin: &Path,
    node_dir: Option<&Path>,
    workspace_dir: &Path,
    baseline_sha: &str,
    inc_tasks: &[PlannedTaskView],
) -> Result<ParityCheckOutcome, String> {
    let inc_sig = plan_signature(inc_tasks);
    let snap_dir = workspace_dir.join(".git/dads-testing");
    let saved = remove_and_backup_snapshots(&snap_dir)?;

    let mut plan_req =
        NativeRequestPayload::new("plan", workspace_dir.to_string_lossy().into_owned());
    plan_req.base = Some(baseline_sha.to_owned());
    let cold_res = invoke_dad(dad_bin, &plan_req, node_dir);

    restore_snapshots(&saved)?;
    let cold_inv = cold_res?;
    let Some(cold_plan) = cold_inv.envelope.result.as_ref().map(|r| &r.plan) else {
        return Ok(ParityCheckOutcome::Diverged {
            kind: "cold-plan-error",
            detail: format!("cold plan failed: {:?}", cold_inv.envelope.error),
        });
    };
    let cold_sig = plan_signature(&cold_plan.tasks);
    if inc_sig != cold_sig {
        return Ok(ParityCheckOutcome::Diverged {
            kind: "snapshot-parity-divergence",
            detail: describe_signature_diff(&inc_sig, &cold_sig),
        });
    }
    Ok(ParityCheckOutcome::Matched)
}

fn plan_signature(tasks: &[PlannedTaskView]) -> PlanSignature {
    tasks
        .iter()
        .map(|t| {
            let mut files = t.selected_files.clone();
            files.sort();
            (t.id.clone(), (t.decision.clone(), files))
        })
        .collect()
}

fn describe_signature_diff(inc: &PlanSignature, cold: &PlanSignature) -> String {
    for (id, inc_val) in inc {
        match cold.get(id) {
            Some(cold_val) if cold_val != inc_val => {
                return format!("task {id}: incremental={inc_val:?} != cold={cold_val:?}");
            }
            None => return format!("task {id} present in incremental plan only"),
            _ => {}
        }
    }
    for id in cold.keys() {
        if !inc.contains_key(id) {
            return format!("task {id} present in cold plan only");
        }
    }
    "plan signature mismatch".to_owned()
}

fn remove_and_backup_snapshots(snap_dir: &Path) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    let mut saved = Vec::new();
    if !snap_dir.is_dir() {
        return Ok(saved);
    }
    for entry in fs::read_dir(snap_dir)
        .map_err(|e| format!("read_dir {}: {e}", snap_dir.display()))?
        .flatten()
    {
        let path = entry.path();
        let is_graph = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("graph-v") && n.ends_with(".json"));
        if is_graph && path.is_file() {
            let bytes = fs::read(&path).map_err(|e| format!("read snapshot: {e}"))?;
            fs::remove_file(&path).map_err(|e| format!("remove snapshot: {e}"))?;
            saved.push((path, bytes));
        }
    }
    Ok(saved)
}

fn restore_snapshots(saved: &[(PathBuf, Vec<u8>)]) -> Result<(), String> {
    for (path, bytes) in saved {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(path, bytes).map_err(|e| format!("restore snapshot: {e}"))?;
    }
    Ok(())
}
