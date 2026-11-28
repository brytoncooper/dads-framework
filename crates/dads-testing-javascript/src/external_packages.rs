//! Workspace-level index of declared external npm packages, workspace package names, and
//! `tsconfig*.json` path aliases so standalone `dad-test plan` (running without `node_modules`)
//! can prove that bare third-party imports like `zod` or `vitest` are external rather than
//! missing workspace modules, while failing closed on undeclared, workspace-owned, locally
//! linked, or alias-matched bare specifiers.

use dads_testing_core::graph::external_package_name;
use dads_testing_core::{specifier_matches_alias, strip_jsonc};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::Path;

const DEPENDENCY_BLOCKS: &[&str] = &[
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
];

const LOCAL_VERSION_PREFIXES: &[&str] = &["workspace:", "file:", "link:", "portal:"];

#[derive(Debug, Default)]
pub(crate) struct ExternalPackageIndex {
    declared_external: HashSet<String>,
    workspace_packages: HashSet<String>,
    local_linked: HashSet<String>,
    /// `(dir_prefix, alias_pattern)` for `compilerOptions.paths` entries that can target workspace
    /// files (excluding aliases whose targets all point into `node_modules/`).
    tsconfig_aliases: Vec<(String, String)>,
}

impl ExternalPackageIndex {
    pub(crate) fn build(workspace_root: &Path, workspace_files: &[String]) -> Self {
        let mut index = Self::default();
        for rel in workspace_files {
            if is_package_json_path(rel) {
                index.ingest_package_json(&workspace_root.join(rel));
            } else if is_tsconfig_json_path(rel) {
                index.ingest_tsconfig(rel, &workspace_root.join(rel));
            }
        }
        index.ingest_package_lock(&workspace_root.join("package-lock.json"));
        index.tsconfig_aliases.sort();
        index.tsconfig_aliases.dedup();
        index
    }

    /// True iff `specifier` imported from `importer_path` is provably a declared external npm
    /// package and cannot refer to a workspace package, local linked dependency, or workspace
    /// `tsconfig` path alias in scope for `importer_path`.
    pub(crate) fn is_known_external_specifier(&self, importer_path: &str, specifier: &str) -> bool {
        let Some(pkg) = external_package_name(specifier) else {
            return false;
        };
        if self.workspace_packages.contains(pkg) || self.local_linked.contains(pkg) {
            return false;
        }
        if self.tsconfig_aliases.iter().any(|(dir_prefix, pattern)| {
            (dir_prefix.is_empty() || importer_path.starts_with(dir_prefix.as_str()))
                && specifier_matches_alias(specifier, pattern)
        }) {
            return false;
        }
        self.declared_external.contains(pkg)
    }

    fn ingest_package_json(&mut self, path: &Path) {
        let Ok(raw) = fs::read_to_string(path) else {
            return;
        };
        let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(&raw) else {
            return;
        };
        if let Some(name) = obj.get("name").and_then(Value::as_str) {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                self.workspace_packages.insert(trimmed.to_owned());
            }
        }
        for block in DEPENDENCY_BLOCKS {
            let Some(Value::Object(deps)) = obj.get(*block) else {
                continue;
            };
            for (dep_name, version_val) in deps {
                let is_local = version_val.as_str().is_some_and(|spec| {
                    LOCAL_VERSION_PREFIXES
                        .iter()
                        .any(|prefix| spec.starts_with(prefix))
                });
                if is_local {
                    self.local_linked.insert(dep_name.clone());
                } else {
                    self.declared_external.insert(dep_name.clone());
                }
            }
        }
    }

    fn ingest_package_lock(&mut self, path: &Path) {
        let Ok(raw) = fs::read_to_string(path) else {
            return;
        };
        let Ok(Value::Object(root)) = serde_json::from_str::<Value>(&raw) else {
            return;
        };
        let Some(Value::Object(packages)) = root.get("packages") else {
            return;
        };
        for (key, entry) in packages {
            let Some(pkg_name) = package_name_from_lock_key(key) else {
                continue;
            };
            let is_link = entry.get("link").and_then(Value::as_bool).unwrap_or(false);
            if is_link {
                self.local_linked.insert(pkg_name.to_owned());
            } else {
                self.declared_external.insert(pkg_name.to_owned());
            }
        }
    }

    fn ingest_tsconfig(&mut self, rel: &str, path: &Path) {
        let Ok(raw) = fs::read_to_string(path) else {
            return;
        };
        let Some(stripped) = strip_jsonc(&raw) else {
            return;
        };
        let Ok(Value::Object(root)) = serde_json::from_str::<Value>(&stripped) else {
            return;
        };
        let Some(Value::Object(opts)) = root.get("compilerOptions") else {
            return;
        };
        let Some(Value::Object(paths)) = opts.get("paths") else {
            return;
        };
        let dir_prefix = match rel.rsplit_once('/') {
            Some((dir, _)) => format!("{dir}/"),
            None => String::new(),
        };
        for (alias, targets) in paths {
            let all_node_modules = targets.as_array().is_some_and(|arr| {
                !arr.is_empty()
                    && arr.iter().all(|t| {
                        t.as_str()
                            .is_some_and(|s| s.split('/').any(|seg| seg == "node_modules"))
                    })
            });
            if !all_node_modules {
                self.tsconfig_aliases
                    .push((dir_prefix.clone(), alias.clone()));
            }
        }
    }
}

fn is_package_json_path(rel: &str) -> bool {
    rel == "package.json" || rel.ends_with("/package.json")
}

fn is_tsconfig_json_path(rel: &str) -> bool {
    let file_name = rel.rsplit('/').next().unwrap_or(rel);
    file_name.starts_with("tsconfig") && file_name.ends_with(".json")
}

fn package_name_from_lock_key(key: &str) -> Option<&str> {
    let (_, tail) = key.rsplit_once("node_modules/")?;
    if tail.is_empty() {
        return None;
    }
    Some(tail)
}
