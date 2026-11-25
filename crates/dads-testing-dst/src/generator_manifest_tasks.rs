//! Task declaration builder for `dads.testing.json` across all 93 DST families.

use crate::generator_manifest::ManifestInputs;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;

pub fn build_tasks(inputs: &ManifestInputs<'_>) -> Value {
    let mut tasks = build_core_and_adv_tasks(inputs);
    tasks.extend(build_subsystem_and_lifecycle_tasks(inputs));
    Value::Array(tasks)
}

fn build_core_and_adv_tasks(inputs: &ManifestInputs<'_>) -> Vec<Value> {
    let shape = inputs.shape;
    let runner_arg = inputs.runner_script.to_string_lossy().into_owned();
    let ts_arg = inputs.typescript_js.to_string_lossy().into_owned();

    let mut ui_args = base_node_args(&runner_arg, &ts_arg);
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

    let impact_pattern = match shape.impact_pattern_idx % 3 {
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
        "../external-flag.txt".to_owned(),
    );
    let mut mode_env = BTreeMap::new();
    mode_env.insert("DST_MODE".to_owned(), "safe".to_owned());
    let empty_env = BTreeMap::new();

    vec![
        json!({
            "id": "ui:test", "project": "ui", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, ui_args, shape.use_file_narrowing, shape.use_setup_file.then_some("ui/setup.ts"), &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": ui_impact_paths }
        }),
        json!({
            "id": "adv:test", "project": "adv", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, &ts_arg, "adv"), shape.use_file_narrowing, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": adv_impact_paths }
        }),
        json!({
            "id": "adv-dyn-fs:test", "project": "adv-dyn-fs", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, &ts_arg, "adv-dyn-fs"), false, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] }
        }),
        json!({
            "id": "adv-always:test", "project": "adv-always", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, &ts_arg, "adv-always"), false, None, &always_env),
            "dependsOn": [],
            "impact": { "mode": "always", "paths": [] }
        }),
        json!({
            "id": "adv-env:test", "project": "adv-env", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, &ts_arg, "adv-env"), false, None, &mode_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] }
        }),
        json!({
            "id": "impact-consumer:test", "project": "impact-consumer", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, &ts_arg, "impact-consumer"), shape.use_file_narrowing, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": impact_paths }
        }),
        json!({
            "id": "build-dep:build", "project": "build-dep", "kind": "build", "cache": false,
            "execution": { "executable": inputs.node_bin.to_string_lossy(), "args": ["build-dep/build.mjs"] },
            "dependsOn": [],
            "impact": { "mode": "project", "paths": [] }
        }),
        json!({
            "id": "build-consumer:test", "project": "build-consumer", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, &ts_arg, "build-consumer"), false, None, &empty_env),
            "dependsOn": ["build-dep:build"],
            "impact": { "mode": "project", "paths": [] }
        }),
        json!({
            "id": "unrelated:test", "project": "unrelated", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, &ts_arg, "unrelated"), shape.use_file_narrowing, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] }
        }),
    ]
}

fn build_subsystem_and_lifecycle_tasks(inputs: &ManifestInputs<'_>) -> Vec<Value> {
    let shape = inputs.shape;
    let runner_arg = inputs.runner_script.to_string_lossy().into_owned();
    let tc_script_arg = inputs.typecheck_script.to_string_lossy().into_owned();
    let ts_arg = inputs.typescript_js.to_string_lossy().into_owned();
    let empty_env = BTreeMap::new();

    let tc_args = vec![
        "--no-warnings".to_owned(),
        tc_script_arg,
        ts_arg.clone(),
        "typecheck-app/tsconfig.json".to_owned(),
    ];

    vec![
        json!({
            "id": "typecheck-app:typecheck", "project": "typecheck-app", "kind": "typecheck", "cache": true,
            "execution": build_execution(inputs.node_bin, tc_args, false, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] }
        }),
        json!({
            "id": "typecheck-app:test", "project": "typecheck-app", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, &ts_arg, "typecheck-app"), shape.use_file_narrowing, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] }
        }),
        json!({
            "id": "sql-migrations:test", "project": "sql-migrations", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, &ts_arg, "sql-migrations"), false, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] },
            "sqlImpact": { "isMigrationRunner": true }
        }),
        json!({
            "id": "sql-accounts:test", "project": "sql-accounts", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, &ts_arg, "sql-accounts"), false, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] },
            "sqlImpact": { "tables": ["public.accounts"] }
        }),
        json!({
            "id": "sql-audits:test", "project": "sql-audits", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, &ts_arg, "sql-audits"), false, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] },
            "sqlImpact": { "tables": ["public.audits"] }
        }),
        json!({
            "id": "lock-alpha:test", "project": "lock-alpha", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, &ts_arg, "lock-alpha"), shape.use_file_narrowing, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] }
        }),
        json!({
            "id": "lock-beta:test", "project": "lock-beta", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, &ts_arg, "lock-beta"), shape.use_file_narrowing, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] }
        }),
        json!({
            "id": "vitest-proj:test", "project": "vitest-proj", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, &ts_arg, "vitest-proj"), shape.use_file_narrowing, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] }
        }),
        json!({
            "id": "next-app:test", "project": "next-app", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, &ts_arg, "next-app"), shape.use_file_narrowing, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] }
        }),
        json!({
            "id": "adv-cache:test", "project": "adv-cache", "kind": "test", "cache": true,
            "execution": build_execution(inputs.node_bin, project_args(&runner_arg, &ts_arg, "adv-cache"), shape.use_file_narrowing, None, &empty_env),
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] }
        }),
    ]
}

fn base_node_args(runner_arg: &str, ts_arg: &str) -> Vec<String> {
    vec![
        "--no-warnings".to_owned(),
        "--experimental-transform-types".to_owned(),
        runner_arg.to_owned(),
        "--ts".to_owned(),
        ts_arg.to_owned(),
    ]
}

fn project_args(runner_arg: &str, ts_arg: &str, project_dir: &str) -> Vec<String> {
    let mut args = base_node_args(runner_arg, ts_arg);
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
