//! Declarative `workspace.discover` expansion into the canonical `TestingManifest` IR.
//!
//! Expansion runs deterministically in memory before validation and planning, so every
//! downstream invariant (including file-level Vitest narrowing and the Lean-proved planner)
//! sees the exact same canonical manifest as a static `dads.testing.json`.

use crate::discover_scan::{DiscoveredProject, discover_projects};
pub(crate) use crate::discover_schema::WorkspaceDiscover;
use crate::discover_schema::{TargetMatch, validate_discover};
use crate::discover_vitest::{apply_auto_vitest_narrowing, normalize_vitest_run_args};
use crate::execute::TestingError;
use crate::manifest::{
    DeclaredTask, FileNarrowing, Project, TaskExecution, TaskImpact, TestingManifest,
};
use crate::scope::path_matches_impact;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// Expands `workspace.discover` (when present) into a fully concrete canonical `TestingManifest`.
pub(crate) fn expand_manifest(
    mut manifest: TestingManifest,
    workspace_root: &Path,
) -> Result<TestingManifest, TestingError> {
    let Some(discover) = manifest.workspace.discover.take() else {
        return Ok(manifest);
    };
    validate_discover(&discover)?;
    let discovered = discover_projects(
        workspace_root,
        &discover.project_files,
        &discover.exclude_roots,
    )?;

    let (merged_projects, discovered_by_id) = merge_projects(discovered, manifest.projects);
    let (mut tasks, optional_dep_tasks) =
        expand_templates(&discover, &discovered_by_id, workspace_root)?;
    apply_overrides(&discover, &discovered_by_id, workspace_root, &mut tasks)?;
    merge_explicit_tasks(&mut tasks, manifest.tasks);
    prune_optional_dependencies(&mut tasks, &optional_dep_tasks);

    manifest.projects = merged_projects;
    manifest.tasks = tasks;
    if manifest.workspace.full_fallback.task_ids.is_empty() {
        manifest.workspace.full_fallback.task_ids =
            manifest.tasks.iter().map(|task| task.id.clone()).collect();
    }
    Ok(manifest)
}

fn merge_projects(
    discovered: Vec<DiscoveredProject>,
    explicit: Vec<Project>,
) -> (Vec<Project>, BTreeMap<String, DiscoveredProject>) {
    let mut by_id: BTreeMap<String, Project> = BTreeMap::new();
    let mut discovered_by_id: BTreeMap<String, DiscoveredProject> = BTreeMap::new();
    for item in discovered {
        by_id.insert(
            item.id.clone(),
            Project {
                id: item.id.clone(),
                root: item.root.clone(),
                fallback_dependencies: item.fallback_dependencies.clone(),
            },
        );
        discovered_by_id.insert(item.id.clone(), item);
    }
    for project in explicit {
        if let Some(existing) = by_id.get_mut(&project.id) {
            existing.root = project.root.clone();
            let mut deps: BTreeSet<String> =
                existing.fallback_dependencies.iter().cloned().collect();
            deps.extend(project.fallback_dependencies);
            existing.fallback_dependencies = deps.into_iter().collect();
        } else {
            by_id.insert(project.id.clone(), project);
        }
    }
    let known_ids: BTreeSet<String> = by_id.keys().cloned().collect();
    for project in by_id.values_mut() {
        let self_id = project.id.clone();
        project
            .fallback_dependencies
            .retain(|dep| dep != &self_id && known_ids.contains(dep));
    }
    (by_id.into_values().collect(), discovered_by_id)
}

fn expand_templates(
    discover: &WorkspaceDiscover,
    discovered_by_id: &BTreeMap<String, DiscoveredProject>,
    workspace_root: &Path,
) -> Result<(Vec<DeclaredTask>, BTreeSet<String>), TestingError> {
    let mut tasks = Vec::new();
    let mut optional_dep_tasks = BTreeSet::new();
    for project in discovered_by_id.values() {
        for template in &discover.target_templates {
            if !matches_project(project, &template.when, workspace_root) {
                continue;
            }
            let id = format!("{}:{}", project.id, template.target);
            if template.depends_on_if_exists {
                optional_dep_tasks.insert(id.clone());
            }
            let mut execution = substitute_execution(&template.execution, project);
            normalize_vitest_run_args(&mut execution);
            let depends_on = template
                .depends_on
                .iter()
                .map(|dep| substitute(dep, project))
                .collect();
            let mut impact_paths = resolve_impact_paths(
                &discover.named_impacts,
                &template.impact.named,
                &template.impact.paths,
                project,
            );
            if template.auto_vitest_narrowing {
                let exclude_integration_tiers = template.target == "test"
                    && (project.targets.contains("test:integration")
                        || project.targets.contains("test:e2e"));
                apply_auto_vitest_narrowing(
                    workspace_root,
                    &project.root,
                    &mut execution,
                    &mut impact_paths,
                    exclude_integration_tiers,
                );
            }
            tasks.push(DeclaredTask {
                id,
                project: project.id.clone(),
                kind: template.kind.clone(),
                execution,
                depends_on,
                impact: TaskImpact {
                    mode: template.impact.mode.clone(),
                    paths: impact_paths,
                },
                sql_impact: template.sql_impact.clone(),
                cache: template.cache,
            });
        }
    }
    Ok((tasks, optional_dep_tasks))
}

fn apply_overrides(
    discover: &WorkspaceDiscover,
    discovered_by_id: &BTreeMap<String, DiscoveredProject>,
    workspace_root: &Path,
    tasks: &mut [DeclaredTask],
) -> Result<(), TestingError> {
    for rule in &discover.task_overrides {
        for task in tasks.iter_mut() {
            let expected_id = format!("{}:{}", task.project, rule.target);
            if task.id != expected_id {
                continue;
            }
            let Some(project) = discovered_by_id.get(&task.project) else {
                continue;
            };
            if !matches_project(project, &rule.when, workspace_root) {
                continue;
            }
            let mut paths: BTreeSet<String> = task.impact.paths.iter().cloned().collect();
            for group in &rule.add_named_impacts {
                if let Some(entries) = discover.named_impacts.get(group) {
                    paths.extend(entries.iter().map(|entry| substitute(entry, project)));
                }
            }
            for raw in &rule.add_impact_paths {
                paths.insert(substitute(raw, project));
            }
            task.impact.paths = paths.into_iter().collect();
            for (k, v) in &rule.env {
                task.execution.env.insert(k.clone(), substitute(v, project));
            }
            if let Some(cwd) = &rule.cwd {
                task.execution.cwd = Some(substitute(cwd, project));
            }
            if let Some(args) = &rule.args {
                task.execution.args = args.iter().map(|arg| substitute(arg, project)).collect();
            }
            if let Some(cache) = rule.cache {
                task.cache = cache;
            }
            if let Some(narrowing) = &rule.file_narrowing {
                task.execution.file_narrowing = Some(substitute_narrowing(narrowing, project));
            }
            if let Some(batch) = &rule.batch {
                task.execution.batch = Some(batch.clone());
            }
            if let Some(sql_impact) = &rule.sql_impact {
                task.sql_impact = Some(sql_impact.clone());
            }
        }
    }
    Ok(())
}

fn merge_explicit_tasks(generated: &mut Vec<DeclaredTask>, explicit: Vec<DeclaredTask>) {
    let mut index_by_id: BTreeMap<String, usize> = generated
        .iter()
        .enumerate()
        .map(|(idx, task)| (task.id.clone(), idx))
        .collect();
    for task in explicit {
        if let Some(&idx) = index_by_id.get(&task.id) {
            generated[idx] = task;
        } else {
            index_by_id.insert(task.id.clone(), generated.len());
            generated.push(task);
        }
    }
}

fn prune_optional_dependencies(tasks: &mut [DeclaredTask], optional_dep_tasks: &BTreeSet<String>) {
    if optional_dep_tasks.is_empty() {
        return;
    }
    let all_ids: BTreeSet<String> = tasks.iter().map(|task| task.id.clone()).collect();
    for task in tasks.iter_mut() {
        if optional_dep_tasks.contains(&task.id) {
            task.depends_on.retain(|dep| all_ids.contains(dep));
        }
    }
}

fn matches_project(
    project: &DiscoveredProject,
    matcher: &TargetMatch,
    workspace_root: &Path,
) -> bool {
    if !matcher.projects.is_empty() && !matcher.projects.iter().any(|p| p == &project.id) {
        return false;
    }
    if matcher.exclude_projects.iter().any(|p| p == &project.id) {
        return false;
    }
    if let Some(target) = &matcher.has_target
        && !project.targets.contains(target)
    {
        return false;
    }
    if let Some(target) = &matcher.not_target
        && project.targets.contains(target)
    {
        return false;
    }
    if let Some(tag) = &matcher.has_tag
        && !project.tags.contains(tag)
    {
        return false;
    }
    if let Some(tag) = &matcher.not_tag
        && project.tags.contains(tag)
    {
        return false;
    }
    if !matcher.root_matches.is_empty()
        && !matcher
            .root_matches
            .iter()
            .any(|pattern| path_matches_impact(&project.root, pattern))
    {
        return false;
    }
    if matcher
        .root_excludes
        .iter()
        .any(|pattern| path_matches_impact(&project.root, pattern))
    {
        return false;
    }
    let project_dir = if project.root == "." {
        workspace_root.to_path_buf()
    } else {
        workspace_root.join(&project.root)
    };
    if matcher
        .file_exists
        .iter()
        .any(|rel| !project_dir.join(rel).exists())
    {
        return false;
    }
    if !matcher.any_file_exists.is_empty()
        && !matcher
            .any_file_exists
            .iter()
            .any(|rel| project_dir.join(rel).exists())
    {
        return false;
    }
    if matcher
        .file_not_exists
        .iter()
        .any(|rel| project_dir.join(rel).exists())
    {
        return false;
    }
    true
}

fn substitute(value: &str, project: &DiscoveredProject) -> String {
    value
        .replace("{projectRoot}", &project.root)
        .replace("{project}", &project.id)
}

fn substitute_execution(template: &TaskExecution, project: &DiscoveredProject) -> TaskExecution {
    TaskExecution {
        executable: substitute(&template.executable, project),
        args: template
            .args
            .iter()
            .map(|arg| substitute(arg, project))
            .collect(),
        cwd: template.cwd.as_deref().map(|c| substitute(c, project)),
        shell: template.shell,
        env: template
            .env
            .iter()
            .map(|(k, v)| (k.clone(), substitute(v, project)))
            .collect(),
        file_narrowing: template
            .file_narrowing
            .as_ref()
            .map(|n| substitute_narrowing(n, project)),
        batch: template.batch.clone(),
    }
}

fn substitute_narrowing(narrowing: &FileNarrowing, project: &DiscoveredProject) -> FileNarrowing {
    FileNarrowing {
        suffixes: narrowing.suffixes.clone(),
        exclude_suffixes: narrowing.exclude_suffixes.clone(),
        setup_files: narrowing
            .setup_files
            .iter()
            .map(|s| substitute(s, project))
            .collect(),
    }
}

fn resolve_impact_paths(
    named_impacts: &BTreeMap<String, Vec<String>>,
    named: &[String],
    paths: &[String],
    project: &DiscoveredProject,
) -> Vec<String> {
    let mut set = BTreeSet::new();
    for group in named {
        if let Some(entries) = named_impacts.get(group) {
            for entry in entries {
                set.insert(substitute(entry, project));
            }
        }
    }
    for raw in paths {
        set.insert(substitute(raw, project));
    }
    set.into_iter().collect()
}
