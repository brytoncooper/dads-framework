use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, execute_request_with_graph,
};
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::{Path, PathBuf};

fn temp_ws(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let root = std::env::temp_dir().join(format!("dads-jest-nx-{name}-{}", std::process::id()));
    let _ = remove_dir_all(&root);
    create_dir_all(&root)?;
    Ok(root)
}

fn seed_jest_nx_workspace(root: &Path) -> Result<(), Box<dyn Error>> {
    for dir in [
        "packages/static-jest",
        "packages/dynamic-jest",
        "packages/lib",
    ] {
        create_dir_all(root.join(dir))?;
    }
    write(
        root.join("packages/lib/package.json"),
        r#"{ "name": "@acme/lib", "scripts": { "test": "jest" } }"#,
    )?;
    write(
        root.join("packages/static-jest/project.json"),
        r#"{ "name": "static-jest", "targets": { "test": {} } }"#,
    )?;
    write(
        root.join("packages/static-jest/package.json"),
        r#"{ "name": "static-jest", "dependencies": { "@acme/lib": "workspace:*" } }"#,
    )?;
    write(
        root.join("packages/static-jest/jest.config.ts"),
        "export default {\n  setupFiles: ['<rootDir>/jest.env.ts'],\n  setupFilesAfterEnv: ['./jest.setup.ts'],\n};\n",
    )?;
    write(
        root.join("packages/dynamic-jest/project.json"),
        r#"{ "name": "dynamic-jest", "targets": { "test": {} } }"#,
    )?;
    write(
        root.join("packages/dynamic-jest/jest.config.ts"),
        "export default { setupFilesAfterEnv: getSetupFiles() };\n",
    )?;
    write(
        root.join("dads.testing.json"),
        r#"{
  "schemaVersion": 1,
  "workspace": {
    "root": ".",
    "discover": {
      "projectFiles": ["packages/*/project.json", "packages/*/package.json"],
      "targetTemplates": [
        {
          "target": "test",
          "kind": "test",
          "when": { "hasTarget": "test" },
          "execution": { "executable": "npx", "args": ["nx", "run", "{project}:test"] },
          "autoJestNarrowing": true,
          "impact": { "mode": "reachability", "paths": [] }
        }
      ]
    }
  }
}"#,
    )?;
    Ok(())
}

#[test]
fn auto_jest_narrowing_extracts_static_setup_files_and_fails_closed_on_dynamic()
-> Result<(), Box<dyn Error>> {
    let root = temp_ws("auto-jest")?;
    seed_jest_nx_workspace(&root)?;

    let req = NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::ExpandManifest,
        workspace_root: root.to_string_lossy().into_owned(),
        ..NativeRequest::default()
    };
    let resp = execute_request_with_graph(req, None);
    assert!(resp.ok, "{resp:?}");
    let expanded = resp
        .result
        .and_then(|r| r.manifest)
        .ok_or("expected expanded manifest")?;
    let projects = expanded["projects"]
        .as_array()
        .ok_or("expected projects array")?;
    let tasks = expanded["tasks"].as_array().ok_or("expected tasks array")?;

    assert_eq!(projects.len(), 3);
    let static_proj = projects
        .iter()
        .find(|p| p["id"] == "static-jest")
        .ok_or("missing static-jest project")?;
    let deps: Vec<&str> = static_proj["fallbackDependencies"]
        .as_array()
        .ok_or("expected fallbackDependencies")?
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert!(deps.contains(&"acme-lib"), "deps: {deps:?}");

    let static_task = tasks
        .iter()
        .find(|t| t["id"] == "static-jest:test")
        .ok_or("missing static-jest:test")?;
    let impact_paths: Vec<&str> = static_task["impact"]["paths"]
        .as_array()
        .ok_or("expected impact.paths")?
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert!(impact_paths.contains(&"packages/static-jest/jest.config.ts"));
    let setup_files: Vec<&str> = static_task["execution"]["fileNarrowing"]["setupFiles"]
        .as_array()
        .ok_or("expected static Jest setupFiles")?
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert!(setup_files.contains(&"packages/static-jest/jest.env.ts"));
    assert!(setup_files.contains(&"packages/static-jest/jest.setup.ts"));

    let dynamic_task = tasks
        .iter()
        .find(|t| t["id"] == "dynamic-jest:test")
        .ok_or("missing dynamic-jest:test")?;
    assert!(dynamic_task["execution"]["fileNarrowing"].is_null());

    let _ = remove_dir_all(&root);
    Ok(())
}
