//! File-lifecycle, git index/commit, cache corruption, and manifest env `ChaosOp` appliers.

use crate::fuzz_graph::{ChaosWorkspaceSpec, relative_import_path};
use crate::fuzz_ops::ChaosLiveState;
use crate::node_oracle::OracleTestSpec;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub fn edit_json_fixture(
    ws: &Path,
    spec: &ChaosWorkspaceSpec,
    fixture_idx: usize,
    delta: i32,
) -> Result<(), String> {
    let Some(fx) = spec.fixtures.get(fixture_idx) else {
        return Ok(());
    };
    let full = ws.join(&fx.rel_path);
    if !full.is_file() {
        return Ok(());
    }
    let raw = fs::read_to_string(&full).map_err(|e| format!("read {}: {e}", fx.rel_path))?;
    let prev = extract_last_i32(&raw).unwrap_or(fx.value);
    fs::write(
        &full,
        format!("{{\"value\":{}}}\n", prev.wrapping_add(delta)),
    )
    .map_err(|e| format!("write {}: {e}", fx.rel_path))
}

pub fn add_module_and_import(
    ws: &Path,
    spec: &ChaosWorkspaceSpec,
    project_idx: usize,
    consumer_mod: usize,
    name: &str,
    value: i32,
) -> Result<(), String> {
    let (Some(proj), Some(consumer)) = (
        spec.projects.get(project_idx),
        spec.modules.get(consumer_mod),
    ) else {
        return Ok(());
    };
    let consumer_full = ws.join(&consumer.rel_path);
    if !consumer_full.is_file() {
        return Ok(());
    }
    let new_rel = format!("{}/{name}.ts", proj.root);
    let new_full = ws.join(&new_rel);
    if let Some(parent) = new_full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    fs::write(
        &new_full,
        format!("export const addedVal: number = {value};\n"),
    )
    .map_err(|e| format!("write {new_rel}: {e}"))?;

    let content = fs::read_to_string(&consumer_full)
        .map_err(|e| format!("read {}: {e}", consumer.rel_path))?;
    let ident = format!("__add_{name}");
    if content.contains(&ident) || !content.contains("// @added-import") {
        return Ok(());
    }
    let rel = relative_import_path(&consumer.rel_path, &new_rel);
    let updated = content
        .replacen(
            "// @added-import",
            &format!("import {{ addedVal as {ident} }} from \"{rel}\";\n// @added-import"),
            1,
        )
        .replacen(
            "acc += 0; // @added-use",
            &format!("acc += {ident};\n  acc += 0; // @added-use"),
            1,
        );
    fs::write(&consumer_full, updated).map_err(|e| format!("write {}: {e}", consumer.rel_path))
}

pub fn add_failing_test(
    ws: &Path,
    spec: &ChaosWorkspaceSpec,
    project_idx: usize,
    name: &str,
    state: &mut ChaosLiveState,
) -> Result<(), String> {
    let Some(proj) = spec.projects.get(project_idx) else {
        return Ok(());
    };
    let rel = format!("{}/{name}.test.ts", proj.root);
    let full = ws.join(&rel);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    fs::write(&full, "throw new Error(\"chaos-added-failing-test\");\n")
        .map_err(|e| format!("write {rel}: {e}"))?;
    let task_id = format!("{}:test", proj.id);
    if !state.extra_task_tests.iter().any(|(_, s)| s.file == rel) {
        state.extra_task_tests.push((
            task_id,
            OracleTestSpec {
                file: rel,
                setup_file: None,
                env: BTreeMap::new(),
            },
        ));
    }
    Ok(())
}

pub fn corrupt_one_cache_blob(cache_dir: &Path, pick: usize) -> Result<(), String> {
    let mut files = Vec::new();
    collect_files(cache_dir, &mut files)?;
    files.sort();
    if let Some(target) = files.get(pick % files.len().max(1)) {
        fs::write(target, b"{chaos-corrupt-blob")
            .map_err(|e| format!("corrupt {}: {e}", target.display()))?;
    }
    Ok(())
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)
        .map_err(|e| format!("read_dir {}: {e}", dir.display()))?
        .flatten()
    {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out)?;
        } else if path.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

pub fn edit_manifest_env(
    ws: &Path,
    spec: &ChaosWorkspaceSpec,
    project_idx: usize,
    val: i32,
    state: &mut ChaosLiveState,
) -> Result<(), String> {
    let Some(proj) = spec.projects.get(project_idx) else {
        return Ok(());
    };
    let manifest_path = ws.join("dads.testing.json");
    let raw = fs::read_to_string(&manifest_path).map_err(|e| format!("read manifest: {e}"))?;
    let mut doc: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse manifest: {e}"))?;
    let task_id = format!("{}:test", proj.id);
    let val_str = val.to_string();
    if let Some(tasks) = doc
        .get_mut("tasks")
        .and_then(serde_json::Value::as_array_mut)
    {
        for task in tasks {
            if task.get("id").and_then(serde_json::Value::as_str) == Some(task_id.as_str())
                && let Some(env) = task
                    .get_mut("execution")
                    .and_then(|e| e.get_mut("env"))
                    .and_then(serde_json::Value::as_object_mut)
            {
                env.insert(
                    "CHAOS_ENV".to_owned(),
                    serde_json::Value::String(val_str.clone()),
                );
            }
        }
    }
    let updated = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    fs::write(&manifest_path, format!("{updated}\n"))
        .map_err(|e| format!("write manifest: {e}"))?;
    state
        .project_env_overrides
        .insert(format!("{}/a-suite.test.ts", proj.root), val_str);
    Ok(())
}

pub fn extract_last_i32(text: &str) -> Option<i32> {
    let bytes = text.as_bytes();
    let mut end = bytes.len();
    while end > 0 && !bytes[end - 1].is_ascii_digit() {
        end -= 1;
    }
    if end == 0 {
        return None;
    }
    let mut start = end;
    while start > 0 && bytes[start - 1].is_ascii_digit() {
        start -= 1;
    }
    if start > 0 && bytes[start - 1] == b'-' {
        start -= 1;
    }
    text[start..end].parse::<i32>().ok()
}
