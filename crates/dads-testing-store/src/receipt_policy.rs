//! Root, ancestor, and project-root configuration & `.env*` files hashed into every task receipt.

use std::collections::BTreeSet;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

const POLICY_FILES: &[&str] = &[
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "tsconfig.json",
    "tsconfig.base.json",
    "tsconfig.paths.json",
    ".oxlintrc.json",
    "eslint.config.mjs",
    "eslint.config.js",
    "eslint.config.ts",
    "eslint.config.mts",
    "vitest.workspace.ts",
    "vitest.workspace.mts",
    "vitest.workspace.js",
    "vitest.workspace.mjs",
    "vitest.config.ts",
    "vitest.config.mts",
    "vitest.config.js",
    "vitest.config.mjs",
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.js",
    "vite.config.mjs",
    "vitest.setup.ts",
    "vitest.setup.mts",
    "vitest.setup.js",
    ".env",
    ".env.local",
    ".env.test",
    ".env.test.local",
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "next.config.mts",
    "next.config.cjs",
    "drizzle.config.ts",
    "drizzle.config.js",
    "drizzle.config.mjs",
    "drizzle.config.mts",
    "tailwind.config.ts",
    "tailwind.config.js",
    "tailwind.config.mjs",
    "tailwind.config.cjs",
    "postcss.config.js",
    "postcss.config.mjs",
    "postcss.config.cjs",
    "postcss.config.ts",
    "babel.config.js",
    "babel.config.mjs",
    "babel.config.cjs",
    "babel.config.json",
    ".babelrc",
    ".babelrc.json",
];

const PROJECT_AND_ANCESTOR_CONFIGS: &[&str] = &[
    ".env",
    ".env.local",
    ".env.test",
    ".env.test.local",
    "package.json",
    "vitest.config.ts",
    "vitest.config.mts",
    "vitest.config.js",
    "vitest.config.mjs",
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.js",
    "vite.config.mjs",
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "next.config.mts",
    "next.config.cjs",
    "drizzle.config.ts",
    "drizzle.config.js",
    "drizzle.config.mjs",
    "tailwind.config.ts",
    "tailwind.config.js",
    "tailwind.config.mjs",
    "postcss.config.js",
    "postcss.config.mjs",
    "babel.config.js",
    "babel.config.mjs",
    "babel.config.json",
];

pub(crate) fn collect_policy_files(
    workspace_root: &Path,
    out: &mut BTreeSet<String>,
) -> Option<()> {
    for policy in POLICY_FILES {
        check_optional_regular_file(workspace_root, policy, out)?;
    }
    Some(())
}

pub(crate) fn collect_root_tsconfig_files(
    workspace_root: &Path,
    out: &mut BTreeSet<String>,
) -> Option<()> {
    collect_tsconfig_files_in_dir(workspace_root, "", out)
}

/// Collects project-root and ancestor-directory configs (including gitignored `.env*` files,
/// ancestor `tsconfig*.json`, `package.json`, and `vitest.config.*`) between each project root and
/// the workspace root. Fails closed on symlinks.
pub(crate) fn collect_project_and_ancestor_configs(
    workspace_root: &Path,
    project_roots: &[String],
    out: &mut BTreeSet<String>,
) -> Option<()> {
    let mut dirs = BTreeSet::new();
    for raw_root in project_roots {
        let trimmed = raw_root.trim().trim_matches('/');
        if trimmed.is_empty() || trimmed == "." {
            continue;
        }
        let mut cursor = trimmed;
        loop {
            dirs.insert(cursor.to_owned());
            let Some((parent, _)) = cursor.rsplit_once('/') else {
                break;
            };
            cursor = parent;
        }
    }
    for dir_rel in dirs {
        let dir_path = workspace_root.join(&dir_rel);
        match fs::symlink_metadata(&dir_path) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return None;
                }
                if !meta.is_dir() {
                    continue;
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(_) => return None,
        }
        for name in PROJECT_AND_ANCESTOR_CONFIGS {
            let rel = format!("{dir_rel}/{name}");
            check_optional_regular_file(workspace_root, &rel, out)?;
        }
        collect_tsconfig_files_in_dir(&dir_path, &dir_rel, out)?;
    }
    Some(())
}

fn check_optional_regular_file(
    workspace_root: &Path,
    rel: &str,
    out: &mut BTreeSet<String>,
) -> Option<()> {
    let candidate = workspace_root.join(rel);
    match fs::symlink_metadata(&candidate) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return None;
            }
            if meta.is_file() {
                out.insert(rel.to_owned());
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(_) => return None,
    }
    Some(())
}

fn collect_tsconfig_files_in_dir(
    dir: &Path,
    rel_prefix: &str,
    out: &mut BTreeSet<String>,
) -> Option<()> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries {
        let entry = entry.ok()?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !name.starts_with("tsconfig") || !name.ends_with(".json") {
            continue;
        }
        let meta = fs::symlink_metadata(entry.path()).ok()?;
        if meta.file_type().is_symlink() {
            return None;
        }
        if meta.is_file() {
            let rel = if rel_prefix.is_empty() {
                name
            } else {
                format!("{rel_prefix}/{name}")
            };
            out.insert(rel);
        }
    }
    Some(())
}
