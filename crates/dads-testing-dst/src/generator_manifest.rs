//! Manifest generation (`dads.testing.json`) for seeded 58-family DST workspaces.

use crate::model::{FallbackMode, WorkspaceShape};
use crate::rng::SeededRng;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub struct ManifestInputs<'a> {
    pub root: &'a Path,
    pub runner_script: &'a Path,
    pub node_bin: &'a Path,
    pub external_flag_path: &'a Path,
    pub shape: &'a WorkspaceShape,
}

pub fn write_root_config_files(root: &Path, shape: &WorkspaceShape) -> Result<(), String> {
    fs::write(
        root.join(".gitignore"),
        "build-dep/dist/\nsettings/generated-ignored/\n.env.test\n",
    )
    .map_err(|e| format!("write .gitignore: {e}"))?;
    fs::write(
        root.join("package.json"),
        "{\n  \"name\": \"dst-workspace\",\n  \"type\": \"module\",\n  \"imports\": {\n    \"#subpath\": \"./lang/subpath-target.ts\"\n  }\n}\n",
    )
    .map_err(|e| format!("write package.json: {e}"))?;
    let paths = if shape.use_tsconfig_aliases {
        json!({
            "@pkg/core": ["core/math.ts"],
            "@pkg/billing": ["billing/tax.ts"],
            "@pkg/dynamic": ["billing/dynamic.ts"]
        })
    } else {
        json!({
            "@pkg/core": ["core/math.ts"]
        })
    };
    let tsconfig_base = json!({
        "compilerOptions": {
            "baseUrl": ".",
            "paths": paths
        }
    });
    let base_json = serde_json::to_string_pretty(&tsconfig_base).map_err(|e| e.to_string())?;
    fs::write(root.join("tsconfig.base.json"), format!("{base_json}\n"))
        .map_err(|e| format!("write tsconfig.base.json: {e}"))?;
    fs::write(
        root.join("tsconfig.json"),
        "{\n  \"extends\": \"./tsconfig.base.json\"\n}\n",
    )
    .map_err(|e| format!("write tsconfig.json: {e}"))
}

pub fn write_manifest(inputs: &ManifestInputs<'_>, rng: &mut SeededRng) -> Result<(), String> {
    let manifest = json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": {
                "taskIds": [
                    "ui:test",
                    "adv:test",
                    "adv-dyn-fs:test",
                    "adv-always:test",
                    "adv-env:test",
                    "impact-consumer:test",
                    "build-dep:build",
                    "build-consumer:test",
                    "unrelated:test"
                ]
            }
        },
        "projects": build_projects(inputs.shape),
        "tasks": build_tasks(inputs, rng)
    });
    let serialized = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(
        inputs.root.join("dads.testing.json"),
        format!("{serialized}\n"),
    )
    .map_err(|error| format!("write dads.testing.json: {error}"))
}

fn build_projects(shape: &WorkspaceShape) -> Value {
    let billing_deps: Vec<&str> = match shape.fallback_mode {
        FallbackMode::Empty => vec![],
        FallbackMode::Partial | FallbackMode::Complete => vec!["core"],
    };
    let ui_deps: Vec<&str> = match shape.fallback_mode {
        FallbackMode::Empty => vec![],
        FallbackMode::Partial => vec!["billing"],
        FallbackMode::Complete => vec!["billing", "settings"],
    };
    let adv_deps: Vec<&str> = match shape.fallback_mode {
        FallbackMode::Empty => vec![],
        FallbackMode::Partial => vec!["lang"],
        FallbackMode::Complete => vec!["lang", "settings"],
    };
    json!([
        { "id": "core", "root": "core", "fallbackDependencies": [] },
        { "id": "billing", "root": "billing", "fallbackDependencies": billing_deps },
        { "id": "settings", "root": "settings", "fallbackDependencies": [] },
        { "id": "ui", "root": "ui", "fallbackDependencies": ui_deps },
        { "id": "lang", "root": "lang", "fallbackDependencies": [] },
        { "id": "lang-pkg", "root": "lang-pkg", "fallbackDependencies": [] },
        { "id": "adv", "root": "adv", "fallbackDependencies": adv_deps },
        { "id": "adv-dyn-fs", "root": "adv-dyn-fs", "fallbackDependencies": [] },
        { "id": "adv-always", "root": "adv-always", "fallbackDependencies": [] },
        { "id": "adv-env", "root": "adv-env", "fallbackDependencies": [] },
        { "id": "impact-consumer", "root": "impact-consumer", "fallbackDependencies": [] },
        { "id": "build-dep", "root": "build-dep", "fallbackDependencies": [] },
        { "id": "build-consumer", "root": "build-consumer", "fallbackDependencies": ["build-dep"] },
        { "id": "unrelated", "root": "unrelated", "fallbackDependencies": [] }
    ])
}

fn build_tasks(inputs: &ManifestInputs<'_>, rng: &mut SeededRng) -> Value {
    let shape = inputs.shape;
    let runner_arg = inputs.runner_script.to_string_lossy().into_owned();
    let mut ui_args = base_node_args(&runner_arg);
    if shape.use_setup_file {
        ui_args.push("--setup".to_owned());
        ui_args.push("ui/setup.ts".to_owned());
    }
    ui_args.push("ui".to_owned());

    let (ui_impact_paths, adv_impact_paths) = if shape.declare_fs_impact_paths {
        (
            vec![
                "settings/disk-limit.json".to_owned(),
                "settings/rules".to_owned(),
            ],
            vec![
                "settings/helper-disk.json".to_owned(),
                "settings/async-limit.json".to_owned(),
                "settings/sentinel.txt".to_owned(),
                "settings/nested-rules".to_owned(),
            ],
        )
    } else {
        (Vec::new(), Vec::new())
    };

    let impact_pattern = match rng.range_usize(3) {
        0 => "settings/impact-flag.json",
        1 => "settings",
        _ => "settings/impact-*.json",
    };
    let impact_paths = vec![
        impact_pattern.to_owned(),
        "settings/impact-*.json".to_owned(),
        "settings/generated-ignored/*.json".to_owned(),
    ];

    let mut always_env = BTreeMap::new();
    always_env.insert(
        "DST_EXTERNAL_FLAG_PATH".to_owned(),
        inputs.external_flag_path.to_string_lossy().into_owned(),
    );
    let mut mode_env = BTreeMap::new();
    mode_env.insert("DST_MODE".to_owned(), "safe".to_owned());
    let empty_env = BTreeMap::new();

    json!([
        {
            "id": "ui:test", "project": "ui", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, ui_args, shape.use_file_narrowing, shape.use_setup_file.then_some("ui/setup.ts"), &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": ui_impact_paths }
        },
        {
            "id": "adv:test", "project": "adv", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, "adv"), shape.use_file_narrowing, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": adv_impact_paths }
        },
        {
            "id": "adv-dyn-fs:test", "project": "adv-dyn-fs", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, "adv-dyn-fs"), false, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] }
        },
        {
            "id": "adv-always:test", "project": "adv-always", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, "adv-always"), false, None, &always_env),
            "dependsOn": [],
            "impact": { "mode": "always", "paths": [] }
        },
        {
            "id": "adv-env:test", "project": "adv-env", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, "adv-env"), false, None, &mode_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] }
        },
        {
            "id": "impact-consumer:test", "project": "impact-consumer", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, "impact-consumer"), shape.use_file_narrowing, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": impact_paths }
        },
        {
            "id": "build-dep:build", "project": "build-dep", "kind": "build", "cache": false,
            "execution": { "executable": inputs.node_bin.to_string_lossy(), "args": ["build-dep/build.mjs"] },
            "dependsOn": [],
            "impact": { "mode": "project", "paths": [] }
        },
        {
            "id": "build-consumer:test", "project": "build-consumer", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, "build-consumer"), false, None, &empty_env),
            "dependsOn": ["build-dep:build"],
            "impact": { "mode": "project", "paths": [] }
        },
        {
            "id": "unrelated:test", "project": "unrelated", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, "unrelated"), shape.use_file_narrowing, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] }
        }
    ])
}

fn base_node_args(runner_arg: &str) -> Vec<String> {
    vec![
        "--no-warnings".to_owned(),
        "--experimental-transform-types".to_owned(),
        runner_arg.to_owned(),
    ]
}

fn project_args(runner_arg: &str, project_dir: &str) -> Vec<String> {
    let mut args = base_node_args(runner_arg);
    args.push(project_dir.to_owned());
    args
}

fn build_execution(
    node_bin: &Path,
    args: Vec<String>,
    file_narrowing: bool,
    setup_file: Option<&str>,
    env: &BTreeMap<String, String>,
) -> Value {
    let mut exec = json!({
        "executable": node_bin.to_string_lossy(),
        "args": args
    });
    if !env.is_empty()
        && let Some(obj) = exec.as_object_mut()
    {
        obj.insert("env".to_owned(), json!(env));
    }
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
