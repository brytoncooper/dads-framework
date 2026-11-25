//! Workspace project metadata (tags, projectType, buildability) and TypeScript path alias index
//! used by native module-boundary enforcement.

use crate::discover_scan::strip_jsonc;
use crate::manifest::Project;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const DECLARED_DEP_FIELDS: &[&str] = &[
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
];

const SKIP_DIRS: &[&str] = &[
    ".git",
    ".nx",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "tmp",
];

#[derive(Debug, Clone)]
pub(crate) struct BoundaryProject {
    pub(crate) id: String,
    pub(crate) root: String,
    pub(crate) tags: Vec<String>,
    pub(crate) project_type: String,
    pub(crate) is_buildable: bool,
}

#[derive(Debug, Clone)]
struct WildcardAlias {
    prefix: String,
    target_prefix: String,
}

#[derive(Debug, Clone)]
pub(crate) struct BoundaryWorkspaceIndex {
    workspace_root: PathBuf,
    projects: Vec<BoundaryProject>,
    exact_aliases: BTreeMap<String, String>,
    wildcard_aliases: Vec<WildcardAlias>,
    root_declared_deps: BTreeSet<String>,
}

impl BoundaryWorkspaceIndex {
    pub(crate) fn load(workspace_root: &Path, manifest_projects: Option<&[Project]>) -> Self {
        let mut projects = match manifest_projects {
            Some(declared) if !declared.is_empty() => load_from_manifest(workspace_root, declared),
            _ => scan_workspace_projects(workspace_root),
        };
        projects.sort_by(|left, right| {
            if left.root == "." && right.root != "." {
                std::cmp::Ordering::Greater
            } else if right.root == "." && left.root != "." {
                std::cmp::Ordering::Less
            } else {
                right
                    .root
                    .len()
                    .cmp(&left.root.len())
                    .then_with(|| left.id.cmp(&right.id))
            }
        });
        let (exact_aliases, wildcard_aliases) = load_tsconfig_aliases(workspace_root);
        let root_declared_deps = load_declared_deps(&workspace_root.join("package.json"));
        Self {
            workspace_root: workspace_root.to_path_buf(),
            projects,
            exact_aliases,
            wildcard_aliases,
            root_declared_deps,
        }
    }

    pub(crate) fn project_count(&self) -> usize {
        self.projects.len()
    }

    pub(crate) fn find_project_for_path(&self, rel_path: &str) -> Option<&BoundaryProject> {
        let clean = rel_path.replace('\\', "/");
        let clean = clean.strip_prefix("./").unwrap_or(&clean);
        for project in &self.projects {
            if project.root == "." {
                return Some(project);
            }
            if clean == project.root
                || clean
                    .strip_prefix(&project.root)
                    .is_some_and(|rest| rest.starts_with('/'))
            {
                return Some(project);
            }
        }
        None
    }

    pub(crate) fn is_exact_alias(&self, specifier: &str) -> bool {
        self.exact_aliases.contains_key(specifier)
    }

    pub(crate) fn matches_wildcard_alias(&self, specifier: &str) -> bool {
        self.wildcard_aliases
            .iter()
            .any(|entry| specifier.starts_with(&entry.prefix))
    }

    pub(crate) fn resolve_alias_target(&self, specifier: &str) -> Option<&BoundaryProject> {
        if let Some(target) = self.exact_aliases.get(specifier) {
            return self.find_project_for_path(target);
        }
        for entry in &self.wildcard_aliases {
            if let Some(rest) = specifier.strip_prefix(&entry.prefix) {
                let candidate = format!("{}{rest}", entry.target_prefix);
                return self.find_project_for_path(&candidate);
            }
        }
        None
    }

    pub(crate) fn is_declared_for_file(
        &self,
        rel_file: &str,
        package_name: &str,
        cache: &mut BTreeMap<PathBuf, BTreeSet<String>>,
    ) -> bool {
        if self.root_declared_deps.contains(package_name) {
            return true;
        }
        let abs_file = self.workspace_root.join(rel_file);
        let mut cursor = abs_file.parent();
        while let Some(dir) = cursor {
            if dir == self.workspace_root || !dir.starts_with(&self.workspace_root) {
                break;
            }
            let candidate = dir.join("package.json");
            let declared = cache
                .entry(candidate.clone())
                .or_insert_with(|| load_declared_deps(&candidate));
            if declared.contains(package_name) {
                return true;
            }
            cursor = dir.parent();
        }
        false
    }
}

fn load_declared_deps(pkg_json_path: &Path) -> BTreeSet<String> {
    let Ok(raw) = fs::read_to_string(pkg_json_path) else {
        return BTreeSet::new();
    };
    let Ok(json) = serde_json::from_str::<Value>(&raw) else {
        return BTreeSet::new();
    };
    let Some(obj) = json.as_object() else {
        return BTreeSet::new();
    };
    let mut declared = BTreeSet::new();
    for field in DECLARED_DEP_FIELDS {
        if let Some(section) = obj.get(*field).and_then(Value::as_object) {
            declared.extend(section.keys().cloned());
        }
    }
    declared
}

fn load_from_manifest(workspace_root: &Path, declared: &[Project]) -> Vec<BoundaryProject> {
    declared
        .iter()
        .map(|project| {
            let project_json = if project.root == "." {
                workspace_root.join("project.json")
            } else {
                workspace_root.join(&project.root).join("project.json")
            };
            let meta = parse_project_json_metadata(&project_json);
            let mut tags: BTreeSet<String> = project.tags.iter().cloned().collect();
            if let Some(ref parsed) = meta {
                tags.extend(parsed.tags.iter().cloned());
            }
            BoundaryProject {
                id: project.id.clone(),
                root: project.root.clone(),
                tags: tags.into_iter().collect(),
                project_type: meta
                    .as_ref()
                    .map(|m| m.project_type.clone())
                    .unwrap_or_else(|| "library".to_owned()),
                is_buildable: meta.as_ref().is_some_and(|m| m.is_buildable),
            }
        })
        .collect()
}

fn scan_workspace_projects(workspace_root: &Path) -> Vec<BoundaryProject> {
    let mut files = Vec::new();
    collect_project_json_files(workspace_root, "", &mut files);
    let mut projects = Vec::new();
    for rel_file in files {
        let abs = workspace_root.join(&rel_file);
        let Some(meta) = parse_project_json_metadata(&abs) else {
            continue;
        };
        let Some(name) = meta.name else {
            continue;
        };
        let root = if rel_file == "project.json" {
            ".".to_owned()
        } else {
            rel_file
                .strip_suffix("/project.json")
                .unwrap_or(&rel_file)
                .to_owned()
        };
        projects.push(BoundaryProject {
            id: name,
            root,
            tags: meta.tags,
            project_type: meta.project_type,
            is_buildable: meta.is_buildable,
        });
    }
    projects
}

fn collect_project_json_files(root_dir: &Path, rel_dir: &str, out: &mut Vec<String>) {
    let abs_dir = if rel_dir.is_empty() {
        root_dir.to_path_buf()
    } else {
        root_dir.join(rel_dir)
    };
    let Ok(entries) = fs::read_dir(&abs_dir) else {
        return;
    };
    let mut children: Vec<_> = entries.flatten().collect();
    children.sort_by_key(|entry| entry.file_name());
    for entry in children {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let child_rel = if rel_dir.is_empty() {
            name.clone()
        } else {
            format!("{rel_dir}/{name}")
        };
        if name == "project.json" && meta.is_file() {
            out.push(child_rel);
        } else if meta.is_dir()
            && !SKIP_DIRS.contains(&name.as_str())
            && !(name.starts_with('.') && rel_dir.is_empty())
        {
            collect_project_json_files(root_dir, &child_rel, out);
        }
    }
}

struct ProjectJsonMeta {
    name: Option<String>,
    tags: Vec<String>,
    project_type: String,
    is_buildable: bool,
}

fn parse_project_json_metadata(path: &Path) -> Option<ProjectJsonMeta> {
    let raw = fs::read_to_string(path).ok()?;
    let json: Value = serde_json::from_str(&strip_jsonc(&raw)).ok()?;
    let obj = json.as_object()?;
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let tags = obj
        .get("tags")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let project_type = obj
        .get("projectType")
        .and_then(Value::as_str)
        .unwrap_or("library")
        .to_owned();
    let is_buildable = obj
        .get("targets")
        .and_then(Value::as_object)
        .and_then(|targets| targets.get("build"))
        .is_some_and(Value::is_object);
    Some(ProjectJsonMeta {
        name,
        tags,
        project_type,
        is_buildable,
    })
}

fn load_tsconfig_aliases(workspace_root: &Path) -> (BTreeMap<String, String>, Vec<WildcardAlias>) {
    let mut merged = BTreeMap::new();
    for candidate in ["tsconfig.json", "tsconfig.base.json", "tsconfig.paths.json"] {
        merge_tsconfig_paths(&workspace_root.join(candidate), &mut merged);
    }
    let mut exact = BTreeMap::new();
    let mut wildcards = Vec::new();
    for (alias, target) in merged {
        let clean = target.strip_prefix("./").unwrap_or(&target).to_owned();
        if let Some(star) = alias.find('*') {
            let target_prefix = match clean.find('*') {
                Some(t_star) => clean[..t_star].to_owned(),
                None => clean,
            };
            wildcards.push(WildcardAlias {
                prefix: alias[..star].to_owned(),
                target_prefix,
            });
        } else {
            exact.insert(alias, clean);
        }
    }
    wildcards.sort_by(|left, right| {
        right
            .prefix
            .len()
            .cmp(&left.prefix.len())
            .then_with(|| left.prefix.cmp(&right.prefix))
    });
    (exact, wildcards)
}

fn merge_tsconfig_paths(path: &Path, merged: &mut BTreeMap<String, String>) {
    let Ok(raw) = fs::read_to_string(path) else {
        return;
    };
    let Ok(json) = serde_json::from_str::<Value>(&strip_jsonc(&raw)) else {
        return;
    };
    let Some(paths) = json
        .as_object()
        .and_then(|obj| obj.get("compilerOptions"))
        .and_then(Value::as_object)
        .and_then(|opts| opts.get("paths"))
        .and_then(Value::as_object)
    else {
        return;
    };
    for (alias, targets) in paths {
        if let Some(first) = targets
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(Value::as_str)
        {
            merged.insert(alias.clone(), first.to_owned());
        }
    }
}
