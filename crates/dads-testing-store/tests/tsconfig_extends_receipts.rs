use dads_testing_core::graph::{DependencyGraph, ModuleNode};
use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, TaskDecision, TaskReceiptEntry,
    TaskReceiptRequest, TaskReceiptStore, collect_project_tsconfig_extends_allowlist,
    execute_request_with_graph,
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

fn receipt_request<'a>(
    root: &'a Path,
    task_id: &'a str,
    project_roots: &'a [String],
    empty_str: &'a [String],
    empty_env: &'a BTreeMap<String, String>,
) -> TaskReceiptRequest<'a> {
    TaskReceiptRequest {
        workspace_root: root,
        task_id,
        executable: "tsc",
        args: empty_str,
        cwd: None,
        env: empty_env,
        project_roots,
        impact_paths: empty_str,
        setup_files: empty_str,
        extra_files: empty_str,
        selected_files: empty_str,
        read_guard_enforced: false,
    }
}

#[test]
fn sideways_multi_hop_and_array_tsconfig_extends_widen_planner_and_invalidate_v5_receipts()
-> Result<(), Box<dyn Error>> {
    let root = fresh_repo("sideways-tsconfig-extends")?;
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
    git(&root, &["add", "."])?;
    git(&root, &["commit", "-q", "-m", "baseline"])?;

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

    // 2. Warm v5 cache receipts for web, admin, and cli.
    let cache_dir = root.join(".cache-receipts");
    let store = FileReceiptStore::with_custom_dir(&cache_dir);
    let empty_str: Vec<String> = Vec::new();
    let empty_env = BTreeMap::new();
    let ok_entry = TaskReceiptEntry {
        exit_code: 0,
        stdout: String::new(),
        stderr: String::new(),
        duration_ms: 5,
    };
    let web_req = receipt_request(&root, "web:typecheck", &web_roots, &empty_str, &empty_env);
    let admin_req = receipt_request(
        &root,
        "admin:typecheck",
        &admin_roots,
        &empty_str,
        &empty_env,
    );
    let cli_req = receipt_request(&root, "cli:typecheck", &cli_roots, &empty_str, &empty_env);
    store.write(&web_req, &ok_entry);
    store.write(&admin_req, &ok_entry);
    store.write(&cli_req, &ok_entry);
    assert!(store.lookup(&web_req).is_some());
    assert!(store.lookup(&admin_req).is_some());
    assert!(store.lookup(&cli_req).is_some());

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

    // Fresh store instance (clears in-memory RunMemoCache) verifies v5 cache invalidation!
    let store_after = FileReceiptStore::with_custom_dir(&cache_dir);
    assert!(
        store_after.lookup(&web_req).is_none(),
        "web:typecheck v5 receipt must invalidate on 2-hop sideways extends edit"
    );
    assert!(
        store_after.lookup(&admin_req).is_none(),
        "admin:typecheck v5 receipt must invalidate on array extends edit"
    );
    assert!(
        store_after.lookup(&cli_req).is_some(),
        "unrelated cli:typecheck v5 receipt must remain cached"
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
    let store_del = FileReceiptStore::with_custom_dir(&cache_dir);
    assert!(
        store_del.lookup(&admin_req).is_none(),
        "broken extends chain must fail closed (no cache hit)"
    );

    remove_dir_all(&root)?;
    Ok(())
}
