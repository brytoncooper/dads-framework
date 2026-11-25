//! Manifest generation (`dads.testing.json`) for seeded DST workspaces.

use crate::model::{FallbackMode, WorkspaceShape};
use crate::rng::SeededRng;
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

pub fn write_manifest(
    root: &Path,
    runner_script: &Path,
    node_bin: &Path,
    shape: &WorkspaceShape,
    rng: &mut SeededRng,
) -> Result<(), String> {
    let billing_deps: Vec<&str> = match shape.fallback_mode {
        FallbackMode::Empty => vec![],
        FallbackMode::Partial | FallbackMode::Complete => vec!["core"],
    };
    let ui_deps: Vec<&str> = match shape.fallback_mode {
        FallbackMode::Empty => vec![],
        FallbackMode::Partial => vec!["billing"],
        FallbackMode::Complete => vec!["billing", "settings"],
    };

    let runner_arg = runner_script.to_string_lossy().into_owned();
    let mut ui_args = vec![runner_arg.clone()];
    if shape.use_setup_file {
        ui_args.push("--setup".to_owned());
        ui_args.push("ui/setup.ts".to_owned());
    }
    ui_args.push("ui".to_owned());

    let mut ui_impact_paths: Vec<String> = Vec::new();
    if shape.declare_fs_impact_paths {
        ui_impact_paths.push("settings/disk-limit.json".to_owned());
        ui_impact_paths.push("settings/rules".to_owned());
    }

    let impact_pattern = match rng.range_usize(3) {
        0 => "settings/impact-flag.json",
        1 => "settings",
        _ => "settings/impact-*.json",
    };

    let ui_exec = build_execution(
        node_bin,
        ui_args,
        shape.use_file_narrowing,
        shape.use_setup_file.then_some("ui/setup.ts"),
    );
    let impact_exec = build_execution(
        node_bin,
        vec![runner_arg.clone(), "impact-consumer".to_owned()],
        shape.use_file_narrowing,
        None,
    );
    let unrelated_exec = build_execution(
        node_bin,
        vec![runner_arg, "unrelated".to_owned()],
        shape.use_file_narrowing,
        None,
    );

    let manifest = json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": {
                "taskIds": ["ui:test", "impact-consumer:test", "unrelated:test"]
            }
        },
        "projects": [
            { "id": "core", "root": "core", "fallbackDependencies": [] },
            { "id": "billing", "root": "billing", "fallbackDependencies": billing_deps },
            { "id": "settings", "root": "settings", "fallbackDependencies": [] },
            { "id": "ui", "root": "ui", "fallbackDependencies": ui_deps },
            { "id": "impact-consumer", "root": "impact-consumer", "fallbackDependencies": [] },
            { "id": "unrelated", "root": "unrelated", "fallbackDependencies": [] }
        ],
        "tasks": [
            {
                "id": "ui:test",
                "project": "ui",
                "kind": "test",
                "cache": true,
                "execution": ui_exec,
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": ui_impact_paths }
            },
            {
                "id": "impact-consumer:test",
                "project": "impact-consumer",
                "kind": "test",
                "cache": true,
                "execution": impact_exec,
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": [impact_pattern] }
            },
            {
                "id": "unrelated:test",
                "project": "unrelated",
                "kind": "test",
                "cache": true,
                "execution": unrelated_exec,
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": [] }
            }
        ]
    });
    let serialized = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(root.join("dads.testing.json"), format!("{serialized}\n"))
        .map_err(|error| format!("write dads.testing.json: {error}"))
}

fn build_execution(
    node_bin: &Path,
    args: Vec<String>,
    file_narrowing: bool,
    setup_file: Option<&str>,
) -> Value {
    let mut exec = json!({
        "executable": node_bin.to_string_lossy(),
        "args": args
    });
    if file_narrowing {
        let setup_files: Vec<&str> = setup_file.into_iter().collect();
        if let Some(obj) = exec.as_object_mut() {
            obj.insert(
                "fileNarrowing".to_owned(),
                json!({
                    "suffixes": [".test.ts"],
                    "setupFiles": setup_files
                }),
            );
        }
    }
    exec
}
