//! Native Rust module-boundary enforcement reusing the Oxc-parsed `DependencyGraph`.

use crate::boundaries_config::{
    BoundariesResult, BoundaryViolation, DepConstraint, WorkspaceBoundaries,
};
use crate::boundaries_index::{BoundaryProject, BoundaryWorkspaceIndex};
use crate::boundaries_match::{
    IGNORED_SPECIFIER_PREFIXES, bfs_reaches, extract_package_name, format_quoted_list,
    has_package_subpath, is_node_builtin, matches_allow, matches_any_tag,
    matches_external_pattern, normalize_relative_posix,
};
use crate::graph::{DependencyGraph, ImportFact, ModuleNode};
use crate::manifest::Project;
use crate::protocol::PROTOCOL_SCHEMA_VERSION;
use crate::scope::is_standard_test_path;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub(crate) fn check_boundaries(
    workspace_root: &Path,
    manifest_projects: Option<&[Project]>,
    config: &WorkspaceBoundaries,
    graph: &DependencyGraph,
    changed_paths: Option<&BTreeSet<String>>,
) -> BoundariesResult {
    let index = BoundaryWorkspaceIndex::load(workspace_root, manifest_projects);
    let mut modules = graph.materialize_modules();
    modules.sort_by(|left, right| left.path.cmp(&right.path));

    let project_graph = build_project_graph(&modules, &index, config);
    let mut reach_cache = BTreeMap::new();
    let mut violations = Vec::new();
    let mut checked_files = 0usize;

    for module in &modules {
        if let Some(filter) = changed_paths
            && !filter.contains(&module.path)
        {
            continue;
        }
        let Some(source_project) = index.find_project_for_path(&module.path) else {
            continue;
        };
        checked_files += 1;
        let matching_constraints: Vec<&DepConstraint> = config
            .dep_constraints
            .iter()
            .filter(|c| {
                c.source_tag == "*" || source_project.tags.iter().any(|t| t == &c.source_tag)
            })
            .collect();

        let mut ctx = CheckCtx {
            index: &index,
            config,
            project_graph: &project_graph,
            reach_cache: &mut reach_cache,
            source_project,
            matching_constraints: &matching_constraints,
            file: &module.path,
            violations: &mut violations,
        };
        for import in &module.imports {
            check_import(&mut ctx, import);
        }
    }

    violations.sort_by(|left, right| {
        left.file
            .cmp(&right.file)
            .then_with(|| left.line.cmp(&right.line))
            .then_with(|| left.column.cmp(&right.column))
            .then_with(|| left.specifier.cmp(&right.specifier))
            .then_with(|| left.rule.cmp(&right.rule))
            .then_with(|| left.message.cmp(&right.message))
    });

    BoundariesResult {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        checked_files,
        total_projects: index.project_count(),
        violations,
    }
}

struct CheckCtx<'a> {
    index: &'a BoundaryWorkspaceIndex,
    config: &'a WorkspaceBoundaries,
    project_graph: &'a BTreeMap<String, BTreeSet<String>>,
    reach_cache: &'a mut BTreeMap<(String, String), bool>,
    source_project: &'a BoundaryProject,
    matching_constraints: &'a [&'a DepConstraint],
    file: &'a str,
    violations: &'a mut Vec<BoundaryViolation>,
}

impl CheckCtx<'_> {
    fn emit(
        &mut self,
        line: u32,
        column: u32,
        target_project: Option<&str>,
        specifier: &str,
        rule: &str,
        message: String,
    ) {
        self.violations.push(BoundaryViolation {
            file: self.file.to_owned(),
            line,
            column,
            source_project: self.source_project.id.clone(),
            target_project: target_project.map(str::to_owned),
            specifier: specifier.to_owned(),
            rule: rule.to_owned(),
            message,
        });
    }

    fn has_dependency_path(&mut self, from: &str, to: &str) -> bool {
        if from == to {
            return true;
        }
        let key = (from.to_owned(), to.to_owned());
        if let Some(&cached) = self.reach_cache.get(&key) {
            return cached;
        }
        let found = bfs_reaches(self.project_graph, from, to);
        self.reach_cache.insert(key, found);
        found
    }
}

fn check_import(ctx: &mut CheckCtx<'_>, import: &ImportFact) {
    let raw_specifier = import.specifier.as_str();
    if raw_specifier.is_empty() || matches_allow(raw_specifier, &ctx.config.allow) {
        return;
    }
    let specifier = raw_specifier.split('?').next().unwrap_or(raw_specifier);
    if IGNORED_SPECIFIER_PREFIXES
        .iter()
        .any(|prefix| specifier.starts_with(prefix))
    {
        return;
    }
    let (line, column) = import
        .position
        .map(|pos| (pos.line, pos.column))
        .unwrap_or((1, 1));

    if specifier.starts_with('.') {
        check_relative_import(ctx, import, specifier, raw_specifier, line, column);
        return;
    }
    if specifier.starts_with('/') {
        return;
    }

    let target_project = resolve_non_relative_target(ctx.index, import, specifier);
    if let Some(target) = target_project {
        if target.id == ctx.source_project.id {
            if !ctx.config.allow_circular_self_dependency {
                ctx.emit(
                    line,
                    column,
                    Some(&target.id),
                    raw_specifier,
                    "circular-self-dependency",
                    format!(
                        "Project \"{}\" cannot import itself via \"{}\". Use a relative import or enable allowCircularSelfDependency.",
                        ctx.source_project.id, raw_specifier
                    ),
                );
            }
            return;
        }
        if ctx.config.check_nested_imports && is_nested_import(ctx.index, specifier) {
            ctx.emit(
                line,
                column,
                Some(&target.id),
                raw_specifier,
                "nested-import",
                format!(
                    "Nested import \"{}\" into project \"{}\" is not allowed. Import from the project's public entry point.",
                    raw_specifier, target.id
                ),
            );
        }
        check_project_constraints(ctx, target, raw_specifier, line, column);
        return;
    }

    check_external_import(ctx, specifier, raw_specifier, line, column);
}

fn check_relative_import(
    ctx: &mut CheckCtx<'_>,
    import: &ImportFact,
    specifier: &str,
    raw_specifier: &str,
    line: u32,
    column: u32,
) {
    let target_path = match &import.resolved_path {
        Some(resolved) => resolved.clone(),
        None => normalize_relative_posix(ctx.file, specifier),
    };
    let Some(target) = ctx.index.find_project_for_path(&target_path) else {
        return;
    };
    if target.id == ctx.source_project.id || target.root == "." {
        return;
    }
    ctx.emit(
        line,
        column,
        Some(&target.id),
        raw_specifier,
        "no-relative-cross-project",
        format!(
            "Projects cannot import from another project (\"{}\") via relative path \"{}\". Import through the public path alias instead.",
            target.id, raw_specifier
        ),
    );
    check_project_constraints(ctx, target, raw_specifier, line, column);
}

fn check_project_constraints(
    ctx: &mut CheckCtx<'_>,
    target: &BoundaryProject,
    raw_specifier: &str,
    line: u32,
    column: u32,
) {
    if ctx.config.enforce_buildable_lib_dependency
        && ctx.source_project.project_type == "library"
        && ctx.source_project.is_buildable
        && target.project_type == "library"
        && !target.is_buildable
    {
        ctx.emit(
            line,
            column,
            Some(&target.id),
            raw_specifier,
            "buildable-lib-dependency",
            format!(
                "Buildable library \"{}\" cannot import non-buildable library \"{}\" (via \"{}\").",
                ctx.source_project.id, target.id, raw_specifier
            ),
        );
    }

    if ctx.has_dependency_path(&target.id, &ctx.source_project.id) {
        ctx.emit(
            line,
            column,
            Some(&target.id),
            raw_specifier,
            "circular-dependency",
            format!(
                "Circular dependency between \"{}\" and \"{}\" detected (via \"{}\").",
                ctx.source_project.id, target.id, raw_specifier
            ),
        );
    }

    for constraint in ctx.matching_constraints {
        if let Some(allowed) = &constraint.only_depend_on_libs_with_tags
            && !matches_any_tag(&target.tags, allowed)
        {
            let allowed_fmt = format_quoted_list(allowed);
            ctx.emit(
                line,
                column,
                Some(&target.id),
                raw_specifier,
                "only-depend-on-libs-with-tags",
                format!(
                    "A project tagged with \"{}\" can only depend on libs tagged with {} (imported \"{}\" via \"{}\").",
                    constraint.source_tag, allowed_fmt, target.id, raw_specifier
                ),
            );
        }
        if let Some(banned) = &constraint.not_depend_on_libs_with_tags
            && matches_any_tag(&target.tags, banned)
        {
            let banned_fmt = format_quoted_list(banned);
            ctx.emit(
                line,
                column,
                Some(&target.id),
                raw_specifier,
                "not-depend-on-libs-with-tags",
                format!(
                    "A project tagged with \"{}\" cannot depend on libs tagged with {} (imported \"{}\" via \"{}\").",
                    constraint.source_tag, banned_fmt, target.id, raw_specifier
                ),
            );
        }
    }
}

fn check_external_import(
    ctx: &mut CheckCtx<'_>,
    specifier: &str,
    raw_specifier: &str,
    line: u32,
    column: u32,
) {
    let pkg_name = extract_package_name(specifier);
    if specifier.starts_with("node:") || is_node_builtin(specifier) || is_node_builtin(pkg_name) {
        return;
    }

    for constraint in ctx.matching_constraints {
        if let Some(banned) = &constraint.banned_external_imports {
            for pattern in banned {
                if matches_external_pattern(specifier, pkg_name, pattern) {
                    ctx.emit(
                        line,
                        column,
                        None,
                        raw_specifier,
                        "banned-external-import",
                        format!(
                            "A project tagged with \"{}\" cannot import external package \"{}\" (matches bannedExternalImports \"{}\").",
                            constraint.source_tag, raw_specifier, pattern
                        ),
                    );
                }
            }
        }
        if let Some(allowed) = &constraint.allowed_external_imports {
            let permitted = allowed
                .iter()
                .any(|pattern| matches_external_pattern(specifier, pkg_name, pattern));
            if !permitted {
                let allowed_fmt = format_quoted_list(allowed);
                ctx.emit(
                    line,
                    column,
                    None,
                    raw_specifier,
                    "allowed-external-import",
                    format!(
                        "A project tagged with \"{}\" can only import external packages matching {} (imported \"{}\").",
                        constraint.source_tag, allowed_fmt, raw_specifier
                    ),
                );
            }
        }
    }
}

fn build_project_graph(
    modules: &[ModuleNode],
    index: &BoundaryWorkspaceIndex,
    config: &WorkspaceBoundaries,
) -> BTreeMap<String, BTreeSet<String>> {
    let mut graph: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for module in modules {
        if is_standard_test_path(&module.path) || module.path.ends_with(".d.ts") {
            continue;
        }
        let Some(source) = index.find_project_for_path(&module.path) else {
            continue;
        };
        if source.root == "." {
            continue;
        }
        for import in &module.imports {
            let raw = import.specifier.as_str();
            if raw.is_empty() || matches_allow(raw, &config.allow) {
                continue;
            }
            let spec = raw.split('?').next().unwrap_or(raw);
            if spec.starts_with('.') || spec.starts_with('/') {
                continue;
            }
            if let Some(target) = resolve_non_relative_target(index, import, spec)
                && target.id != source.id
            {
                graph
                    .entry(source.id.clone())
                    .or_default()
                    .insert(target.id.clone());
            }
        }
    }
    graph
}

fn resolve_non_relative_target<'a>(
    index: &'a BoundaryWorkspaceIndex,
    import: &ImportFact,
    specifier: &str,
) -> Option<&'a BoundaryProject> {
    if let Some(resolved) = &import.resolved_path
        && let Some(project) = index.find_project_for_path(resolved)
    {
        return Some(project);
    }
    index.resolve_alias_target(specifier)
}

fn is_nested_import(index: &BoundaryWorkspaceIndex, specifier: &str) -> bool {
    if index.is_exact_alias(specifier) {
        return false;
    }
    index.matches_wildcard_alias(specifier) || has_package_subpath(specifier)
}
