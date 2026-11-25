use dads_testing_core::graph::{DependencyGraph, ModuleNode};
use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, TaskDecision, TaskReceiptRequest,
    TaskReceiptStore, collect_project_tsconfig_extends_allowlist, execute_request_with_graph,
};
use dads_testing_store::FileReceiptStore;
use std::collections::BTreeMap;
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all, remove_file, write};
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(root: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let out = Command::new("git").current_dir(root).args(args).output()?;
    if !out.status.success() {
        return Err(format!(
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        )
        .into());
    }
    Ok(())
}

fn fresh_repo(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let root =
        std::env::temp_dir().join(format!("dads-testing-store-{name}-{}", std::process::id()));
    let _ = remove_dir_all(&root);
    create_dir_all(&root)?;
    git(&root, &["init", "-q"])?;
    git(&root, &["config", "user.email", "test@example.com"])?;
    git(&root, &["config", "user.name", "Test"])?;
    Ok(root)
}

fn find_task<'a>(tasks: &'a [TaskDecision], id: &str) -> Result<&'a TaskDecision, Box<dyn Error>> {
    tasks
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("missing task {id}").into())
}

fn empty_module(path: &str) -> ModuleNode {
    ModuleNode {
        path: path.to_owned(),
        language: "typescript".to_owned(),
        declarations: Vec::new(),
        references: Vec::new(),
        imports: Vec::new(),
    }
}

fn plan_with_empty_graph(root: &Path) -> Result<dads_testing_core::PlanResult, Box<dyn Error>> {
    let graph = DependencyGraph::new(
        vec![
            empty_module("apps/web/index.ts"),
            empty_module("apps/admin/index.ts"),
            empty_module("apps/cli/index.ts"),
        ],
        Vec::new(),
    );
    let resp = execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Plan,
            workspace_root: root.to_string_lossy().into_owned(),
            ..NativeRequest::default()
        },
        Some(graph),
    );
    assert!(resp.ok, "{resp:?}");
    Ok(resp.result.ok_or("missing plan result")?.plan)
}

fn receipt_key(
    store: &FileReceiptStore,
    root: &Path,
    task_id: &str,
    project_roots: &[String],
) -> Option<String> {
    let empty: Vec<String> = Vec::new();
    let env = BTreeMap::new();
    let manifest = root.join("dads.testing.json");
    store.begin_run();
    store.compute_key(&TaskReceiptRequest {
        task_id,
        project: task_id.split(':').next().unwrap_or(task_id),
        executable: "tsc",
        args: &empty,
        cwd: None,
        shell: false,
        env: &env,
        setup_files: &empty,
        selected_files: &empty,
        project_roots,
        impact_paths: &empty,
        extra_files: &empty,
        manifest_path: &manifest,
        workspace_root: root,
    })
}

fn write_fixture(root: &Path) -> Result<(), Box<dyn Error>> {
    for dir in [
        "packages/base-config",
        "packages/shared-config",
        "apps/web",
        "apps/admin",
        "apps/cli",
    ] {
        create_dir_all(root.join(dir))?;
    }

    write(
        root.join("packages/base-config/base.json"),
        "{\n  \"compilerOptions\": { \"strict\": false }\n}\n",
    )?;
    // Multi-hop extensionless extends: react.json -> ../base-config/base
    write(
        root.join("packages/shared-config/react.json"),
        "{\n  \"extends\": \"../base-config/base\",\n  \"compilerOptions\": { \"jsx\": \"react-jsx\" }\n}\n",
    )?;
    write(
        root.join("packages/shared-config/strict.json"),
        "{\n  \"compilerOptions\": { \"noUnusedLocals\": false }\n}\n",
    )?;
    write(
        root.join("apps/web/tsconfig.json"),
        "{\n  \"extends\": \"../../packages/shared-config/react.json\"\n}\n",
    )?;
    // TypeScript 5 array extends
    write(
        root.join("apps/admin/tsconfig.json"),
        "{\n  \"extends\": [\"../../packages/base-config/base.json\", \"../../packages/shared-config/strict.json\"]\n}\n",
    )?;
    write(
        root.join("apps/cli/tsconfig.json"),
        "{\n  \"compilerOptions\": { \"strict\": true }\n}\n",
    )?;
    write(root.join("apps/web/index.ts"), "export const w = 1;\n")?;
    write(root.join("apps/admin/index.ts"), "export const a = 1;\n")?;
    write(root.join("apps/cli/index.ts"), "export const c = 1;\n")?;

    write(
        root.join("dads.testing.json"),
        r#"{
  "schemaVersion": 1,
  "workspace": { "fullFallback": { "taskIds": ["base-config:test", "shared-config:test", "web:typecheck", "admin:typecheck", "cli:typecheck"] } },
  "projects": [
    { "id": "base-config", "root": "packages/base-config", "fallbackDependencies": [] },
    { "id": "shared-config", "root": "packages/shared-config", "fallbackDependencies": [] },
    { "id": "web", "root": "apps/web", "fallbackDependencies": [] },
    { "id": "admin", "root": "apps/admin", "fallbackDependencies": [] },
    { "id": "cli", "root": "apps/cli", "fallbackDependencies": [] }
  ],
  "tasks": [
    { "id": "base-config:test", "project": "base-config", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "shared-config:test", "project": "shared-config", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "web:typecheck", "project": "web", "kind": "typecheck", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "admin:typecheck", "project": "admin", "kind": "typecheck", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "cli:typecheck", "project": "cli", "kind": "typecheck", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
  ]
}
"#,
    )?;
    git(root, &["add", "."])?;
    git(root, &["commit", "-q", "-m", "baseline"])?;

    Ok(())
}

#[test]
fn sideways_multi_hop_and_array_tsconfig_extends_widen_planner_and_invalidate_v5_receipts()
-> Result<(), Box<dyn Error>> {
    let root = fresh_repo("sideways-tsconfig-extends")?;
    write_fixture(&root)?;

    // 1. Read-guard allowlist sees both sideways hops for apps/web.
    let web_roots = vec!["apps/web".to_owned()];
    let admin_roots = vec!["apps/admin".to_owned()];
    let cli_roots = vec!["apps/cli".to_owned()];
    let allow_web = collect_project_tsconfig_extends_allowlist(&root, &web_roots);
    assert!(
        allow_web.contains(&"packages/shared-config/react.json".to_owned()),
        "allowlist must include direct sideways extends: {allow_web:?}"
    );
    assert!(
        allow_web.contains(&"packages/base-config/base.json".to_owned()),
        "allowlist must include multi-hop sideways extends: {allow_web:?}"
    );

    // 2. Compute baseline v5 receipt keys for web, admin, and cli.
    let store = FileReceiptStore::for_cache_dir(&root.join(".cache-receipts"));
    let web_before = receipt_key(&store, &root, "web:typecheck", &web_roots).ok_or("web key")?;
    let admin_before =
        receipt_key(&store, &root, "admin:typecheck", &admin_roots).ok_or("admin key")?;
    let cli_before = receipt_key(&store, &root, "cli:typecheck", &cli_roots).ok_or("cli key")?;

    // 3. Mutate the 2-hop sideways base config (not named tsconfig*.json!).
    write(
        root.join("packages/base-config/base.json"),
        "{\n  \"compilerOptions\": { \"strict\": true }\n}\n",
    )?;

    let plan = plan_with_empty_graph(&root)?;
    assert!(!plan.scope.full_fallback);
    assert_eq!(find_task(&plan.tasks, "web:typecheck")?.decision, "run");
    assert_eq!(find_task(&plan.tasks, "admin:typecheck")?.decision, "run");
    assert_eq!(
        find_task(&plan.tasks, "cli:typecheck")?.decision,
        "skip-proven-unaffected",
        "unrelated project must stay skipped"
    );
    assert!(
        plan.issues
            .iter()
            .any(|i| i.code == "tsconfig-extends-changed"),
        "expected tsconfig-extends-changed issue: {:?}",
        plan.issues
    );

    let web_after = receipt_key(&store, &root, "web:typecheck", &web_roots).ok_or("web key")?;
    let admin_after =
        receipt_key(&store, &root, "admin:typecheck", &admin_roots).ok_or("admin key")?;
    let cli_after = receipt_key(&store, &root, "cli:typecheck", &cli_roots).ok_or("cli key")?;
    assert_ne!(
        web_before, web_after,
        "web receipt key must change on 2-hop sideways extends edit"
    );
    assert_ne!(
        admin_before, admin_after,
        "admin receipt key must change on array extends edit"
    );
    assert_eq!(
        cli_before, cli_after,
        "unrelated cli receipt key must stay stable"
    );

    // 4. Deleting a sideways extended config fails closed in both planner and receipts.
    write(
        root.join("packages/base-config/base.json"),
        "{\n  \"compilerOptions\": { \"strict\": false }\n}\n",
    )?;
    remove_file(root.join("packages/shared-config/strict.json"))?;
    let plan_del = plan_with_empty_graph(&root)?;
    assert_eq!(
        find_task(&plan_del.tasks, "admin:typecheck")?.decision,
        "run"
    );
    assert_eq!(
        find_task(&plan_del.tasks, "cli:typecheck")?.decision,
        "skip-proven-unaffected"
    );
    assert!(
        plan_del
            .issues
            .iter()
            .any(|i| i.code == "tsconfig-extends-unresolved"),
        "expected tsconfig-extends-unresolved on deleted extended config: {:?}",
        plan_del.issues
    );
    assert!(
        receipt_key(&store, &root, "admin:typecheck", &admin_roots).is_none(),
        "broken extends chain must fail closed (no receipt key)"
    );
    assert!(
        receipt_key(&store, &root, "cli:typecheck", &cli_roots).is_some(),
        "unrelated cli must still be cacheable"
    );

    remove_dir_all(&root)?;
    Ok(())
}
