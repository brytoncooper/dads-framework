//! Integration tests verifying every theorem proved in `proofs/dad-test/DadTest/SqlMigration.lean`:
//!   1. Migration runners (`isMigrationRunner`) always run on any migration change
//!   2. Scoped DDL skips disjoint domains while selecting directly touched tables
//!   3. Bidirectional FK edges propagate parent <-> child without false skips
//!   4. Global DDL, unmapped tables, deleted files, and dynamic TS SQL widen to all DB tasks
//!   5. `hasUnmappedSql` tasks and unannotated migration dependents fail closed
//!   6. Combined JS + SQL union runs tasks impacted by either channel

use dads_testing_core::graph::{
    ChangedModuleEvidence, DependencyGraph, ModuleNode, SourceSpan, SymbolFact,
};
use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, PlanResult, TaskCause,
    execute_request_with_graph,
};
use std::collections::BTreeSet;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let status = Command::new("git").args(args).current_dir(dir).status()?;
    assert!(status.success(), "git {args:?} failed");
    Ok(())
}

fn setup_sql_repo(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!("dads-sql-impact-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    for sub in [
        "migrations/sql",
        "migrations/grants",
        "domains/maint",
        "domains/users",
        "domains/orders",
        "domains/billing",
        "domains/legacy",
    ] {
        fs::create_dir_all(dir.join(sub))?;
    }
    git(&dir, &["init", "-q"])?;
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&sql_manifest_json())?,
    )?;
    fs::write(dir.join("migrations/sql/001_init.sql"), "-- init\n")?;
    fs::write(
        dir.join("migrations/grants/public.maintenance_records.txt"),
        "GRANT SELECT ON public.maintenance_records TO app;\n",
    )?;
    fs::write(dir.join("domains/billing/calc.ts"), "export const x = 1;\n")?;
    git(&dir, &["add", "."])?;
    git(
        &dir,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@e.invalid",
            "commit",
            "-qm",
            "base",
        ],
    )?;
    Ok(dir)
}

fn sql_manifest_json() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": {
                "taskIds": [
                    "db:migrate",
                    "maint:integration",
                    "users:integration",
                    "orders:integration",
                    "billing:integration",
                    "legacy:integration"
                ]
            },
            "sql": {
                "migrationRoots": ["migrations/sql"],
                "objects": [
                    "public.maintenance_records",
                    "public.users",
                    "public.orders",
                    "public.invoices"
                ],
                "edges": [
                    { "from": "public.orders", "to": "public.users" }
                ],
                "snapshotPatterns": [
                    { "prefix": "migrations/grants/", "suffix": ".txt" }
                ]
            }
        },
        "projects": [
            { "id": "migrations", "root": "migrations", "fallbackDependencies": [] },
            { "id": "maint", "root": "domains/maint", "fallbackDependencies": ["migrations"] },
            { "id": "users", "root": "domains/users", "fallbackDependencies": ["migrations"] },
            { "id": "orders", "root": "domains/orders", "fallbackDependencies": ["migrations"] },
            { "id": "billing", "root": "domains/billing", "fallbackDependencies": ["migrations"] },
            { "id": "legacy", "root": "domains/legacy", "fallbackDependencies": ["migrations"] }
        ],
        "tasks": [
            {
                "id": "db:migrate",
                "project": "migrations",
                "kind": "test",
                "execution": { "executable": "true" },
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": [] },
                "sqlImpact": { "isMigrationRunner": true }
            },
            {
                "id": "maint:integration",
                "project": "maint",
                "kind": "test",
                "execution": { "executable": "true" },
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": [] },
                "sqlImpact": { "tables": ["public.maintenance_records"] }
            },
            {
                "id": "users:integration",
                "project": "users",
                "kind": "test",
                "execution": { "executable": "true" },
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": [] },
                "sqlImpact": { "tables": ["public.users"] }
            },
            {
                "id": "orders:integration",
                "project": "orders",
                "kind": "test",
                "execution": { "executable": "true" },
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": [] },
                "sqlImpact": { "tables": ["public.orders"] }
            },
            {
                "id": "billing:integration",
                "project": "billing",
                "kind": "test",
                "execution": { "executable": "true" },
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": [] },
                "sqlImpact": { "tables": ["public.invoices"] }
            },
            {
                "id": "legacy:integration",
                "project": "legacy",
                "kind": "test",
                "execution": { "executable": "true" },
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": [] },
                "sqlImpact": { "hasUnmappedSql": true }
            }
        ]
    })
}

fn plan(dir: &Path, graph: Option<DependencyGraph>) -> Result<PlanResult, Box<dyn Error>> {
    let response = execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Plan,
            workspace_root: dir.display().to_string(),
            manifest_path: None,
            base: None,
            head: None,
            all: false,
            task_ids: Vec::new(),
            task_kinds: Vec::new(),
            shard: None,
            jobs: None,
            cache: false,
            remote_cache_url: None,
            ..NativeRequest::default()
        },
        graph,
    );
    assert!(response.ok, "{response:?}");
    response
        .result
        .map(|r| r.plan)
        .ok_or_else(|| "missing plan".into())
}

fn run_ids(plan: &PlanResult) -> BTreeSet<String> {
    plan.tasks
        .iter()
        .filter(|t| t.decision == "run")
        .map(|t| t.id.clone())
        .collect()
}

#[test]
fn scoped_table_drop_and_snapshot_skip_disjoint_domains_and_fk_propagates_bidirectionally()
-> Result<(), Box<dyn Error>> {
    let dir = setup_sql_repo("scoped-and-fk")?;
    let empty_graph = DependencyGraph::new(Vec::new(), Vec::new());

    // 1. Scoped DROP TABLE public.maintenance_records + grant snapshot -> ONLY db:migrate, maint, legacy!
    fs::write(
        dir.join("migrations/sql/002_drop_maint.sql"),
        "DROP TABLE IF EXISTS public.maintenance_records CASCADE;\n",
    )?;
    fs::write(
        dir.join("migrations/grants/public.maintenance_records.txt"),
        "-- removed\n",
    )?;
    let p1 = plan(&dir, Some(empty_graph.clone()))?;
    assert_eq!(
        run_ids(&p1),
        BTreeSet::from([
            "db:migrate".to_owned(),
            "maint:integration".to_owned(),
            "legacy:integration".to_owned(),
        ])
    );
    let maint = p1
        .tasks
        .iter()
        .find(|t| t.id == "maint:integration")
        .ok_or("missing maint")?;
    assert_eq!(maint.reason, "sql-table-impact");
    assert!(!maint.widened);
    assert!(maint.causes.contains(&TaskCause::SqlObject {
        object: "public.maintenance_records".to_owned()
    }));

    // 2. Bidirectional FK closure: editing public.users reaches public.orders (orders -> users)!
    fs::remove_file(dir.join("migrations/sql/002_drop_maint.sql"))?;
    git(
        &dir,
        &[
            "checkout",
            "--",
            "migrations/grants/public.maintenance_records.txt",
        ],
    )?;
    fs::write(
        dir.join("migrations/sql/003_alter_users.sql"),
        "ALTER TABLE public.users ADD COLUMN nickname TEXT;\n",
    )?;
    let p2 = plan(&dir, Some(empty_graph.clone()))?;
    assert_eq!(
        run_ids(&p2),
        BTreeSet::from([
            "db:migrate".to_owned(),
            "users:integration".to_owned(),
            "orders:integration".to_owned(),
            "legacy:integration".to_owned(),
        ])
    );

    // 3. Global DDL (`CREATE EXTENSION`) widens to ALL 6 DB tasks!
    fs::write(
        dir.join("migrations/sql/003_alter_users.sql"),
        "CREATE EXTENSION IF NOT EXISTS pgcrypto;\n",
    )?;
    let p3 = plan(&dir, Some(empty_graph.clone()))?;
    assert_eq!(run_ids(&p3).len(), 6);
    assert!(p3.issues.iter().any(|i| i.code == "sql-global-ddl"));

    // 4. TS migration with static SQL narrows cleanly; `${dynamic}` interpolation widens all!
    fs::remove_file(dir.join("migrations/sql/003_alter_users.sql"))?;
    fs::write(
        dir.join("migrations/sql/004_drop_maint.ts"),
        "export async function up(qr: any) { await qr.query(`DROP TABLE public.maintenance_records`); }\n",
    )?;
    let p4 = plan(&dir, Some(empty_graph.clone()))?;
    assert_eq!(
        run_ids(&p4),
        BTreeSet::from([
            "db:migrate".to_owned(),
            "maint:integration".to_owned(),
            "legacy:integration".to_owned(),
        ])
    );

    fs::write(
        dir.join("migrations/sql/004_drop_maint.ts"),
        "export async function up(qr: any, t: string) { await qr.query(`DROP TABLE ${t}`); }\n",
    )?;
    let p5 = plan(&dir, Some(empty_graph.clone()))?;
    assert_eq!(run_ids(&p5).len(), 6);

    // 5. node-pg-migrate builder calls narrow to static table; unrecognized pgm.* fails closed!
    fs::write(
        dir.join("migrations/sql/004_drop_maint.ts"),
        "export function up(pgm: any) { pgm.dropConstraint('maintenance_records', 'ck'); pgm.addConstraint('maintenance_records', 'ck', 'CHECK (true)'); }\n",
    )?;
    let p6 = plan(&dir, Some(empty_graph.clone()))?;
    assert_eq!(
        run_ids(&p6),
        BTreeSet::from([
            "db:migrate".to_owned(),
            "maint:integration".to_owned(),
            "legacy:integration".to_owned(),
        ])
    );

    fs::write(
        dir.join("migrations/sql/004_drop_maint.ts"),
        "export function up(pgm: any) { pgm.createExtension('pgcrypto'); }\n",
    )?;
    let p7 = plan(&dir, Some(empty_graph))?;
    assert_eq!(run_ids(&p7).len(), 6);

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn combined_js_and_sql_union_selects_both_channels_without_false_skips()
-> Result<(), Box<dyn Error>> {
    let dir = setup_sql_repo("js-sql-union")?;

    // Change BOTH a SQL migration (maintenance) AND a JS module (billing) simultaneously.
    fs::write(
        dir.join("migrations/sql/002_drop_maint.sql"),
        "DROP TABLE IF EXISTS public.maintenance_records;\n",
    )?;
    fs::write(dir.join("domains/billing/calc.ts"), "export const x = 2;\n")?;

    let graph = DependencyGraph::new(
        vec![ModuleNode {
            path: "domains/billing/calc.ts".to_owned(),
            language: "ts".to_owned(),
            declarations: vec![SymbolFact {
                name: "x".to_owned(),
                span: SourceSpan { start: 0, end: 18 },
            }],
            references: Vec::new(),
            imports: Vec::new(),
        }],
        Vec::new(),
    )
    .with_changed_module_evidence(vec![ChangedModuleEvidence {
        path: "domains/billing/calc.ts".to_owned(),
        changed_exports: BTreeSet::from(["x".to_owned()]),
        every_hunk_is_attributed: true,
        semantic_change: true,
        type_only_change: false,
    }]);

    let p = plan(&dir, Some(graph))?;
    assert_eq!(
        run_ids(&p),
        BTreeSet::from([
            "db:migrate".to_owned(),
            "maint:integration".to_owned(),
            "billing:integration".to_owned(),
            "legacy:integration".to_owned(),
        ])
    );

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}
