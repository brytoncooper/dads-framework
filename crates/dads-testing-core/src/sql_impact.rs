//! SQL / migration table-level impact planner.
//!
//! Directly implements the algorithm formally proved in
//! `proofs/dad-test/DadTest/SqlMigration.lean`:
//! - Theorem 1 (`sql_migration_runner_always_selected`): every task with
//!   `isMigrationRunner = true` runs whenever any migration artifact changes.
//! - Theorem 2 (`sql_global_ddl_widens_all_db_tasks`): any unrecognized or global DDL
//!   widens to every DB task.
//! - Theorem 3 (`sql_unmapped_project_widens_conservatively`): any task with
//!   `hasUnmappedSql = true` (or any unannotated reachability task whose project
//!   transitively `fallbackDepends` on a changed migration project) runs on any migration change.
//! - Theorem 4 & 5 (`sql_no_false_migration_skips`, `sql_select_exact_iff`): bidirectional
//!   closure over FK/view/trigger/function edges selects every affected domain DB task
//!   and skips disjoint domains.
//! - Theorem 6 (`combined_js_and_sql_no_false_skips`): composes by union with JS/TS reachability.

use crate::manifest::{DeclaredTask, TestingManifest};
use crate::protocol::{IssueScope, IssueSeverity, PlanIssue, ResolvedScope};
use crate::scope::{deepest_project_for_path, path_is_inside};
use crate::sql_lexer::normalize_sql_object;
use crate::sql_manifest::{SqlSnapshotPattern, WorkspaceSqlSettings};
use crate::sql_parser::{
    ParsedMigrationDdl, parse_sql_migration_source, parse_ts_migration_source,
};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone)]
pub(crate) struct SqlTaskSelection {
    pub(crate) reason: &'static str,
    pub(crate) confidence: &'static str,
    pub(crate) widened: bool,
    pub(crate) matched_tables: Vec<String>,
    pub(crate) issue_indexes: Vec<usize>,
}

#[derive(Debug, Default)]
pub(crate) struct SqlImpactReport {
    pub(crate) handled_paths: BTreeSet<String>,
    pub(crate) selected_tasks: BTreeMap<String, SqlTaskSelection>,
    pub(crate) issues: Vec<PlanIssue>,
}

pub(crate) fn analyze_sql_impact(
    manifest: &TestingManifest,
    scope: &ResolvedScope,
    workspace_root: &Path,
) -> SqlImpactReport {
    let mut report = SqlImpactReport::default();
    if scope.full_fallback || scope.changed_paths.is_empty() {
        return report;
    }
    let Some(sql_config) = &manifest.workspace.sql else {
        return report;
    };

    let sql_changed_paths: Vec<String> = scope
        .changed_paths
        .iter()
        .filter(|path| is_sql_managed_path(path, sql_config))
        .cloned()
        .collect();
    if sql_changed_paths.is_empty() {
        return report;
    }

    let (schema_objects, mut edges) = collect_schema_inventory(manifest, sql_config);
    let mut touched_objects = BTreeSet::new();
    let mut global_issue_indexes = Vec::new();

    for path in &sql_changed_paths {
        report.handled_paths.insert(path.clone());
        let owning_project = deepest_project_for_path(&manifest.projects, path);
        match classify_changed_sql_path(workspace_root, path, sql_config) {
            ParsedMigrationDdl::Scoped { tables, fk_edges } => {
                for (from, to) in fk_edges {
                    edges.push((from, to));
                }
                for table in tables {
                    if !schema_objects.contains(&table) {
                        let idx = report.issues.len();
                        global_issue_indexes.push(idx);
                        report.issues.push(PlanIssue {
                            path: Some(path.clone()),
                            project: owning_project.map(|p| p.id.clone()),
                            ..PlanIssue::new(
                                "sql-unmapped-table",
                                format!(
                                    "{path} touches SQL object {table} not listed in workspace.sql.objects; widened to all DB tasks."
                                ),
                                IssueSeverity::Uncertainty,
                                IssueScope::Workspace,
                            )
                        });
                    } else {
                        touched_objects.insert(table);
                    }
                }
            }
            ParsedMigrationDdl::GlobalDdl { reason } => {
                let idx = report.issues.len();
                global_issue_indexes.push(idx);
                report.issues.push(PlanIssue {
                    path: Some(path.clone()),
                    project: owning_project.map(|p| p.id.clone()),
                    ..PlanIssue::new(
                        "sql-global-ddl",
                        format!("{path}: {reason}; widened to all DB tasks."),
                        IssueSeverity::Uncertainty,
                        IssueScope::Workspace,
                    )
                });
            }
        }
    }

    let closure = bidirectional_sql_closure(&schema_objects, &edges, &touched_objects);
    let global_uncertainty = !global_issue_indexes.is_empty();

    for task in &manifest.tasks {
        if let Some(selection) = evaluate_task_sql_impact(
            task,
            &closure,
            global_uncertainty,
            &global_issue_indexes,
            &mut report.issues,
        ) {
            report.selected_tasks.insert(task.id.clone(), selection);
        }
    }

    report
}

fn collect_schema_inventory(
    manifest: &TestingManifest,
    sql_config: &WorkspaceSqlSettings,
) -> (BTreeSet<String>, Vec<(String, String)>) {
    let mut schema_objects = BTreeSet::new();
    let mut edges = Vec::new();
    for obj in &sql_config.objects {
        if let Some(norm) = normalize_sql_object(obj) {
            schema_objects.insert(norm);
        }
    }
    for edge in &sql_config.edges {
        if let (Some(from), Some(to)) = (
            normalize_sql_object(&edge.from),
            normalize_sql_object(&edge.to),
        ) {
            schema_objects.insert(from.clone());
            schema_objects.insert(to.clone());
            edges.push((from, to));
        }
    }
    for task in &manifest.tasks {
        if let Some(impact) = &task.sql_impact {
            for table in &impact.tables {
                if let Some(norm) = normalize_sql_object(table) {
                    schema_objects.insert(norm);
                }
            }
        }
    }
    (schema_objects, edges)
}

fn evaluate_task_sql_impact(
    task: &DeclaredTask,
    closure: &BTreeSet<String>,
    global_uncertainty: bool,
    global_issue_indexes: &[usize],
    issues: &mut Vec<PlanIssue>,
) -> Option<SqlTaskSelection> {
    let spec = task.sql_impact.as_ref()?;
    if spec.is_migration_runner {
        return Some(SqlTaskSelection {
            reason: "sql-migration-runner",
            confidence: "sql-schema-derived",
            widened: false,
            matched_tables: Vec::new(),
            issue_indexes: Vec::new(),
        });
    }
    if spec.has_unmapped_sql {
        let idx = issues.len();
        issues.push(PlanIssue {
            project: Some(task.project.clone()),
            ..PlanIssue::new(
                "sql-task-unmapped",
                format!(
                    "Task {} declares unmapped/dynamic SQL; selected conservatively for migration changes.",
                    task.id
                ),
                IssueSeverity::Uncertainty,
                IssueScope::Module,
            )
        });
        return Some(SqlTaskSelection {
            reason: "sql-unmapped-project",
            confidence: "conservative",
            widened: true,
            matched_tables: Vec::new(),
            issue_indexes: vec![idx],
        });
    }
    if global_uncertainty {
        return Some(SqlTaskSelection {
            reason: "sql-global-ddl-fallback",
            confidence: "conservative",
            widened: true,
            matched_tables: Vec::new(),
            issue_indexes: global_issue_indexes.to_vec(),
        });
    }
    let matched: Vec<String> = spec
        .tables
        .iter()
        .filter_map(|t| normalize_sql_object(t))
        .filter(|t| closure.contains(t))
        .collect();
    if !matched.is_empty() {
        return Some(SqlTaskSelection {
            reason: "sql-table-impact",
            confidence: "sql-schema-derived",
            widened: false,
            matched_tables: matched,
            issue_indexes: Vec::new(),
        });
    }
    None
}

fn is_sql_managed_path(path: &str, config: &WorkspaceSqlSettings) -> bool {
    config
        .migration_roots
        .iter()
        .any(|root| path_is_inside(path, root))
        || config
            .snapshot_patterns
            .iter()
            .any(|pattern| path.starts_with(&pattern.prefix) && path.ends_with(&pattern.suffix))
}

fn classify_changed_sql_path(
    workspace_root: &Path,
    path: &str,
    config: &WorkspaceSqlSettings,
) -> ParsedMigrationDdl {
    if let Some(pattern) = config
        .snapshot_patterns
        .iter()
        .find(|p| path.starts_with(&p.prefix) && path.ends_with(&p.suffix))
    {
        return classify_snapshot_path(path, pattern);
    }
    let full = workspace_root.join(path);
    let Ok(source) = fs::read_to_string(&full) else {
        return ParsedMigrationDdl::GlobalDdl {
            reason: "migration file deleted or unreadable".to_owned(),
        };
    };
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".sql") {
        parse_sql_migration_source(&source)
    } else if lower.ends_with(".ts")
        || lower.ends_with(".mts")
        || lower.ends_with(".js")
        || lower.ends_with(".mjs")
    {
        parse_ts_migration_source(&source)
    } else {
        ParsedMigrationDdl::GlobalDdl {
            reason: "unrecognized non-SQL artifact inside migrationRoots".to_owned(),
        }
    }
}

fn classify_snapshot_path(path: &str, pattern: &SqlSnapshotPattern) -> ParsedMigrationDdl {
    let Some(without_prefix) = path.strip_prefix(&pattern.prefix) else {
        return ParsedMigrationDdl::GlobalDdl {
            reason: "snapshot prefix mismatch".to_owned(),
        };
    };
    let Some(raw_name) = without_prefix.strip_suffix(&pattern.suffix) else {
        return ParsedMigrationDdl::GlobalDdl {
            reason: "snapshot suffix mismatch".to_owned(),
        };
    };
    if raw_name.contains('/') {
        return ParsedMigrationDdl::GlobalDdl {
            reason: format!("nested snapshot path '{raw_name}' cannot map to a single SQL object"),
        };
    }
    match normalize_sql_object(raw_name) {
        Some(object) => ParsedMigrationDdl::Scoped {
            tables: BTreeSet::from([object]),
            fk_edges: Vec::new(),
        },
        None => ParsedMigrationDdl::GlobalDdl {
            reason: format!("invalid SQL object name '{raw_name}' in snapshot filename"),
        },
    }
}

fn bidirectional_sql_closure(
    objects: &BTreeSet<String>,
    edges: &[(String, String)],
    seeds: &BTreeSet<String>,
) -> BTreeSet<String> {
    let mut reached = BTreeSet::new();
    let mut queue = VecDeque::new();
    for seed in seeds {
        if objects.contains(seed) && reached.insert(seed.clone()) {
            queue.push_back(seed.clone());
        }
    }
    while let Some(current) = queue.pop_front() {
        for (from, to) in edges {
            if from == &current && objects.contains(to) && reached.insert(to.clone()) {
                queue.push_back(to.clone());
            }
            if to == &current && objects.contains(from) && reached.insert(from.clone()) {
                queue.push_back(from.clone());
            }
        }
    }
    reached
}
