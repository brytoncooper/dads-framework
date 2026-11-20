use crate::graph::{DependencyGraph, ReachedEdge};
use crate::manifest::{DeclaredTask, TestingManifest};
use crate::protocol::TaskCause;
use crate::scope::{deepest_project_for_path, path_is_inside};
use std::collections::{BTreeMap, BTreeSet};

/// The located evidence a decision can cite. Each reason names the subset that explains it.
pub(super) struct CauseEvidence<'a> {
    pub(super) manifest: &'a TestingManifest,
    pub(super) graph: Option<&'a DependencyGraph>,
    pub(super) selected: &'a BTreeSet<&'a str>,
    pub(super) changed_paths: &'a [String],
    pub(super) changed_paths_by_project: &'a BTreeMap<&'a str, Vec<String>>,
    pub(super) issue_indexes_by_project: &'a BTreeMap<&'a str, Vec<usize>>,
    pub(super) full_fallback_issue_indexes: &'a [usize],
    pub(super) fallback_origins: &'a BTreeMap<&'a str, BTreeSet<&'a str>>,
    pub(super) uncertainty_origins: &'a BTreeMap<&'a str, BTreeSet<&'a str>>,
    pub(super) reached_edges: &'a [ReachedEdge],
}

impl CauseEvidence<'_> {
    pub(super) fn has_changed_file_input(&self, task: &DeclaredTask) -> bool {
        self.changed_file_inputs(task).next().is_some()
    }

    pub(super) fn for_task(&self, task: &DeclaredTask, reason: &str) -> Vec<TaskCause> {
        match reason {
            "direct-task-input" => vec![TaskCause::DirectTaskInput {
                task_id: task.id.clone(),
            }],
            "full-fallback" => self
                .full_fallback_issue_indexes
                .iter()
                .map(|index| TaskCause::Issue { index: *index })
                .collect(),
            "changed-file-input" => self
                .changed_file_inputs(task)
                .map(|path| TaskCause::ChangedPath { path: path.clone() })
                .collect(),
            "graph-uncertainty-project-fallback" => {
                self.widening_causes(self.uncertainty_origins, task)
            }
            "selected-prerequisite" => self
                .manifest
                .tasks
                .iter()
                .filter(|candidate| {
                    candidate
                        .depends_on
                        .iter()
                        .any(|dependency| dependency == &task.id)
                        && self.selected.contains(candidate.id.as_str())
                })
                .map(|candidate| TaskCause::PrerequisiteOf {
                    task_id: candidate.id.clone(),
                })
                .collect(),
            "graph-changed-export" => self.changed_export_causes(task.project.as_str()),
            "graph-symbol-importer" => self.reached_import_causes(task.project.as_str()),
            "changed-owned-project" => self.changed_project_causes(task),
            _ => Vec::new(),
        }
    }

    fn changed_file_inputs<'a>(
        &'a self,
        task: &'a DeclaredTask,
    ) -> impl Iterator<Item = &'a String> {
        self.changed_paths.iter().filter(move |changed_path| {
            task.impact
                .paths
                .iter()
                .any(|input_path| path_is_inside(changed_path, input_path))
        })
    }

    fn widening_causes(
        &self,
        origins: &BTreeMap<&str, BTreeSet<&str>>,
        task: &DeclaredTask,
    ) -> Vec<TaskCause> {
        let mut causes = Vec::new();
        for origin in origins.get(task.project.as_str()).into_iter().flatten() {
            for index in self
                .issue_indexes_by_project
                .get(*origin)
                .into_iter()
                .flatten()
            {
                causes.push(TaskCause::Issue { index: *index });
            }
            if *origin != task.project.as_str() {
                causes.push(TaskCause::FallbackDependency {
                    project: (*origin).to_owned(),
                });
            }
        }
        causes
    }

    fn changed_export_causes(&self, project: &str) -> Vec<TaskCause> {
        let mut causes = Vec::new();
        for path in self
            .changed_paths_by_project
            .get(project)
            .into_iter()
            .flatten()
        {
            causes.push(TaskCause::ChangedPath { path: path.clone() });
            for symbol in self
                .graph
                .and_then(|graph| graph.changed_exports(path))
                .into_iter()
                .flatten()
            {
                causes.push(TaskCause::ChangedExport {
                    path: path.clone(),
                    symbol,
                });
            }
        }
        causes
    }

    fn reached_import_causes(&self, project: &str) -> Vec<TaskCause> {
        self.reached_edges
            .iter()
            .filter(|edge| {
                deepest_project_for_path(&self.manifest.projects, &edge.importer)
                    .is_some_and(|owner| owner.id == project)
            })
            .map(|edge| TaskCause::ReachedImport {
                path: edge.importer.clone(),
                line: edge.position.map(|position| position.line),
                column: edge.position.map(|position| position.column),
                imported_from: edge.target.clone(),
                symbols: edge.symbols.iter().cloned().collect(),
            })
            .collect()
    }

    fn changed_project_causes(&self, task: &DeclaredTask) -> Vec<TaskCause> {
        let mut causes = self.changed_path_causes(task.project.as_str());
        for origin in self
            .fallback_origins
            .get(task.project.as_str())
            .into_iter()
            .flatten()
            .filter(|origin| **origin != task.project.as_str())
        {
            causes.push(TaskCause::FallbackDependency {
                project: (*origin).to_owned(),
            });
            causes.extend(self.changed_path_causes(origin));
        }
        causes
    }

    fn changed_path_causes(&self, project: &str) -> Vec<TaskCause> {
        self.changed_paths_by_project
            .get(project)
            .into_iter()
            .flatten()
            .map(|path| TaskCause::ChangedPath { path: path.clone() })
            .collect()
    }
}
