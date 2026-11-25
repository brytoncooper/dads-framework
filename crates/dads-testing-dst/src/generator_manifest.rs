//! Root workspace config files and manifest (`dads.testing.json`) generation for 93-family DST.

use crate::generator_manifest_tasks::build_tasks;
use crate::model::{FallbackMode, WorkspaceShape};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

pub struct ManifestInputs<'a> {
    pub root: &'a Path,
    pub runner_script: &'a Path,
    pub typecheck_script: &'a Path,
    pub typescript_js: &'a Path,
    pub node_bin: &'a Path,
    pub shape: &'a WorkspaceShape,
}

/// Writes shape-independent root files (`.gitignore`, `package.json`, `package-lock.json`,
/// `tsconfig.json`) into the static skeleton workspace.
pub fn write_static_root_config_files(root: &Path) -> Result<(), String> {
    fs::write(
        root.join(".gitignore"),
        "build-dep/dist/\nsettings/generated-ignored/\n.env.test\nnode_modules/\n",
    )
    .map_err(|e| format!("write .gitignore: {e}"))?;
    fs::write(
        root.join("package.json"),
        concat!(
            "{\n",
            "  \"name\": \"dst-workspace\",\n",
            "  \"type\": \"module\",\n",
            "  \"imports\": {\n",
            "    \"#subpath\": \"./lang/subpath-target.ts\"\n",
            "  },\n",
            "  \"dependencies\": {\n",
            "    \"dst-alpha-dep\": \"1.0.0\",\n",
            "    \"dst-beta-dep\": \"1.0.0\"\n",
            "  }\n",
            "}\n",
        ),
    )
    .map_err(|e| format!("write package.json: {e}"))?;
    write_baseline_package_lock(root)?;
    fs::write(
        root.join("tsconfig.json"),
        "{\n  \"extends\": \"./tsconfig.base.json\"\n}\n",
    )
    .map_err(|e| format!("write tsconfig.json: {e}"))
}

/// Writes shape-dependent `tsconfig.base.json` (switching `@pkg/*` aliases per shape).
pub fn write_shape_tsconfig_base(root: &Path, shape: &WorkspaceShape) -> Result<(), String> {
    let paths = if shape.use_tsconfig_aliases {
        json!({
            "@pkg/core": ["core/math.ts"],
            "@pkg/billing": ["billing/tax.ts"],
            "@pkg/dynamic": ["billing/dynamic.ts"],
            "@bnd/shared": ["bnd-shared/util.ts"],
            "@bnd/server": ["bnd-server/db.ts"],
            "@bnd/browser": ["bnd-browser/app.ts"]
        })
    } else {
        json!({
            "@pkg/core": ["core/math.ts"],
            "@bnd/shared": ["bnd-shared/util.ts"],
            "@bnd/server": ["bnd-server/db.ts"],
            "@bnd/browser": ["bnd-browser/app.ts"]
        })
    };
    let tsconfig_base = json!({
        "compilerOptions": {
            "baseUrl": ".",
            "paths": paths
        }
    });
    let base_json = serde_json::to_string_pretty(&tsconfig_base).map_err(|e| e.to_string())?;
    fs::write(root.join("tsconfig.base.json"), format!("{base_json}\n"))
        .map_err(|e| format!("write tsconfig.base.json: {e}"))
}

pub fn write_manifest(inputs: &ManifestInputs<'_>) -> Result<(), String> {
    let manifest = json!({
        "schemaVersion": 1,
        "workspace": build_workspace_settings(),
        "projects": build_projects(inputs.shape),
        "tasks": build_tasks(inputs)
    });
    let serialized = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(
        inputs.root.join("dads.testing.json"),
        format!("{serialized}\n"),
    )
    .map_err(|error| format!("write dads.testing.json: {error}"))
}

fn write_baseline_package_lock(root: &Path) -> Result<(), String> {
    let lock = json!({
        "name": "dst-workspace",
        "lockfileVersion": 3,
        "packages": {
            "": {
                "name": "dst-workspace",
                "dependencies": {
                    "dst-alpha-dep": "1.0.0",
                    "dst-beta-dep": "1.0.0"
                }
            },
            "node_modules/dst-alpha-dep": {
                "version": "1.0.0",
                "dependencies": {
                    "dst-alpha-leaf": "1.0.0"
                }
            },
            "node_modules/dst-alpha-leaf": {
                "version": "1.0.0"
            },
            "node_modules/dst-beta-dep": {
                "version": "1.0.0"
            },
            "node_modules/typescript": {
                "version": "5.8.0",
                "dev": true
            }
        }
    });
    let serialized = serde_json::to_string_pretty(&lock).map_err(|e| e.to_string())?;
    fs::write(root.join("package-lock.json"), format!("{serialized}\n"))
        .map_err(|e| format!("write package-lock.json: {e}"))
}

fn build_workspace_settings() -> Value {
    json!({
        "root": ".",
        "pureFactories": ["z.*", "createCtx"],
        "fullFallback": {
            "taskIds": [
                "ui:test",
                "adv:test",
                "adv-dyn-fs:test",
                "adv-always:test",
                "adv-env:test",
                "impact-consumer:test",
                "build-dep:build",
                "build-consumer:test",
                "unrelated:test",
                "typecheck-app:typecheck",
                "typecheck-app:test",
                "sql-migrations:test",
                "sql-accounts:test",
                "sql-audits:test",
                "lock-alpha:test",
                "lock-beta:test",
                "vitest-proj:test",
                "next-app:test",
                "adv-cache:test"
            ]
        },
        "sql": {
            "migrationRoots": ["sql-migrations/sql"],
            "objects": ["public.accounts", "public.audits"],
            "edges": [],
            "snapshotPatterns": [
                { "prefix": "sql-migrations/grants/", "suffix": ".txt" }
            ]
        },
        "boundaries": {
            "depConstraints": [
                {
                    "sourceTag": "scope:browser",
                    "onlyDependOnLibsWithTags": ["scope:shared"],
                    "notDependOnLibsWithTags": ["scope:server"],
                    "bannedExternalImports": ["pg", "fs-extra"]
                },
                {
                    "sourceTag": "scope:server",
                    "onlyDependOnLibsWithTags": ["scope:shared", "scope:server"]
                },
                {
                    "sourceTag": "scope:shared",
                    "onlyDependOnLibsWithTags": ["scope:shared"]
                }
            ],
            "banTransitiveDependencies": true,
            "excludeProjects": [
                "core", "billing", "settings", "ui", "lang", "lang-pkg",
                "adv", "adv-dyn-fs", "adv-always", "adv-env",
                "impact-consumer", "build-dep", "build-consumer", "unrelated",
                "types-lib", "typecheck-app",
                "sql-migrations", "sql-accounts", "sql-audits",
                "lock-alpha", "lock-beta", "vitest-proj", "next-app", "adv-cache"
            ]
        }
    })
}

fn build_projects(shape: &WorkspaceShape) -> Value {
    let billing_deps: Vec<&str> = match shape.fallback_mode {
        FallbackMode::Empty => vec![],
        FallbackMode::Partial | FallbackMode::Complete => vec!["core"],
    };
    let ui_deps: Vec<&str> = match shape.fallback_mode {
        FallbackMode::Empty => vec![],
        FallbackMode::Partial => vec!["billing"],
        FallbackMode::Complete => vec!["billing", "settings"],
    };
    let adv_deps: Vec<&str> = match shape.fallback_mode {
        FallbackMode::Empty => vec![],
        FallbackMode::Partial => vec!["lang"],
        FallbackMode::Complete => vec!["lang", "settings"],
    };
    let tc_deps: Vec<&str> = match shape.fallback_mode {
        FallbackMode::Empty => vec![],
        FallbackMode::Partial | FallbackMode::Complete => vec!["types-lib"],
    };
    json!([
        { "id": "core", "root": "core", "fallbackDependencies": [] },
        { "id": "billing", "root": "billing", "fallbackDependencies": billing_deps },
        { "id": "settings", "root": "settings", "fallbackDependencies": [] },
        { "id": "ui", "root": "ui", "fallbackDependencies": ui_deps },
        { "id": "lang", "root": "lang", "fallbackDependencies": [] },
        { "id": "lang-pkg", "root": "lang-pkg", "fallbackDependencies": [] },
        { "id": "adv", "root": "adv", "fallbackDependencies": adv_deps },
        { "id": "adv-dyn-fs", "root": "adv-dyn-fs", "fallbackDependencies": [] },
        { "id": "adv-always", "root": "adv-always", "fallbackDependencies": [] },
        { "id": "adv-env", "root": "adv-env", "fallbackDependencies": [] },
        { "id": "impact-consumer", "root": "impact-consumer", "fallbackDependencies": [] },
        { "id": "build-dep", "root": "build-dep", "fallbackDependencies": [] },
        { "id": "build-consumer", "root": "build-consumer", "fallbackDependencies": ["build-dep"] },
        { "id": "unrelated", "root": "unrelated", "fallbackDependencies": [] },
        { "id": "types-lib", "root": "types-lib", "fallbackDependencies": [] },
        { "id": "typecheck-app", "root": "typecheck-app", "fallbackDependencies": tc_deps },
        { "id": "sql-migrations", "root": "sql-migrations", "fallbackDependencies": [] },
        { "id": "sql-accounts", "root": "sql-accounts", "fallbackDependencies": [] },
        { "id": "sql-audits", "root": "sql-audits", "fallbackDependencies": [] },
        { "id": "lock-alpha", "root": "lock-alpha", "fallbackDependencies": [] },
        { "id": "lock-beta", "root": "lock-beta", "fallbackDependencies": [] },
        { "id": "vitest-proj", "root": "vitest-proj", "fallbackDependencies": [] },
        { "id": "bnd-shared", "root": "bnd-shared", "fallbackDependencies": [], "tags": ["scope:shared"] },
        { "id": "bnd-server", "root": "bnd-server", "fallbackDependencies": [], "tags": ["scope:server"] },
        { "id": "bnd-browser", "root": "bnd-browser", "fallbackDependencies": [], "tags": ["scope:browser"] },
        { "id": "next-app", "root": "next-app", "fallbackDependencies": [] },
        { "id": "adv-cache", "root": "adv-cache", "fallbackDependencies": [] }
    ])
}
