//! Parsing `package-lock.json` (lockfileVersion 3), root `package.json` dependency blocks, and
//! classifying global toolchain packages for lockfile package-diff narrowing.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const ALLOWED_MANIFEST_DEP_KEYS: &[&str] = &[
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
];

const TOOLCHAIN_EXACT_PACKAGES: &[&str] = &[
    "typescript",
    "vitest",
    "eslint",
    "oxlint",
    "vite",
    "esbuild",
    "tsx",
    "prettier",
    "nx",
    "jest",
    "ts-node",
    "typescript-eslint",
    "swc",
    "postcss",
    "tailwindcss",
    "autoprefixer",
    "rollup",
    "webpack",
    "turbo",
    "node-pg-migrate",
    "drizzle-kit",
    "playwright",
    "jsdom",
    "happy-dom",
    "c8",
    "rimraf",
];

const TOOLCHAIN_PREFIXES: &[&str] = &[
    "@types/",
    "@vitest/",
    "@typescript-eslint/",
    "@nx/",
    "@swc/",
    "@babel/",
    "@playwright/",
    "@oxc-",
    "@biomejs/",
    "@vitejs/",
    "@eslint/",
    "@esbuild/",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PackageSnapshot {
    pub(crate) name: String,
    pub(crate) version: Option<String>,
    pub(crate) integrity: Option<String>,
    pub(crate) resolved: Option<String>,
    pub(crate) dev: bool,
    pub(crate) optional: bool,
    pub(crate) peer: bool,
    pub(crate) has_bin: bool,
    pub(crate) has_install_script: bool,
    pub(crate) deps: BTreeSet<String>,
}

pub(crate) fn parse_lockfile_v3_packages(raw: &str) -> Option<BTreeMap<String, PackageSnapshot>> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let version = parsed.get("lockfileVersion")?.as_u64()?;
    if version != 3 {
        return None;
    }
    let packages = parsed.get("packages")?.as_object()?;
    let mut map = BTreeMap::new();
    for (key, value) in packages {
        if key.is_empty() {
            continue;
        }
        let Some(name) = package_name_from_lock_key(key, value) else {
            continue;
        };
        let obj = value.as_object()?;
        let mut deps = BTreeSet::new();
        for field in ["dependencies", "optionalDependencies", "peerDependencies"] {
            if let Some(dep_obj) = obj.get(field).and_then(Value::as_object) {
                for dep_name in dep_obj.keys() {
                    deps.insert(dep_name.clone());
                }
            }
        }
        map.insert(
            key.clone(),
            PackageSnapshot {
                name,
                version: obj.get("version").and_then(Value::as_str).map(str::to_owned),
                integrity: obj
                    .get("integrity")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                resolved: obj
                    .get("resolved")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                dev: obj.get("dev").and_then(Value::as_bool).unwrap_or(false),
                optional: obj
                    .get("optional")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                peer: obj.get("peer").and_then(Value::as_bool).unwrap_or(false),
                has_bin: obj.get("bin").is_some(),
                has_install_script: obj
                    .get("hasInstallScript")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                deps,
            },
        );
    }
    Some(map)
}

fn package_name_from_lock_key(key: &str, value: &Value) -> Option<String> {
    if let Some(name) = value.get("name").and_then(Value::as_str)
        && !name.is_empty()
    {
        return Some(name.to_owned());
    }
    let marker = "node_modules/";
    let idx = key.rfind(marker)?;
    let tail = &key[idx + marker.len()..];
    (!tail.is_empty()).then(|| tail.to_owned())
}

pub(crate) fn only_dependency_blocks_changed(base_raw: &str, head_raw: &str) -> bool {
    let Ok(Value::Object(base_obj)) = serde_json::from_str::<Value>(base_raw) else {
        return false;
    };
    let Ok(Value::Object(head_obj)) = serde_json::from_str::<Value>(head_raw) else {
        return false;
    };
    let all_keys: BTreeSet<&String> = base_obj.keys().chain(head_obj.keys()).collect();
    for key in all_keys {
        if ALLOWED_MANIFEST_DEP_KEYS.contains(&key.as_str()) {
            continue;
        }
        if base_obj.get(key) != head_obj.get(key) {
            return false;
        }
    }
    true
}

pub(crate) fn is_toolchain_package(name: &str) -> bool {
    TOOLCHAIN_EXACT_PACKAGES.contains(&name)
        || TOOLCHAIN_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
}
