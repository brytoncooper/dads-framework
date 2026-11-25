//! APFS CoW (`cp -cR`) baseline workspace template cache for fast multi-worker DST sweeps.
//!
//! Builds ONE shape-independent static skeleton once per process, then lazily builds and warms
//! one frozen baseline workspace + `.git` + `shared-cache` per distinct `TemplateKey` (safe under
//! concurrent worker threads via per-key `OnceLock`). Every scenario clones its template via
//! macOS APFS `cp -cR` (falling back to recursive copy on non-APFS / Linux) and cleans up the
//! entire process-scoped temp directory on `Drop`.

use crate::generator::{
    GeneratedWorkspace, StaticSkeletonMeta, build_generated_metadata, write_shape_overlay,
    write_static_skeleton,
};
use crate::generator_manifest::ManifestInputs;
use crate::model::{BarrelStyle, FallbackMode, WorkspaceShape};
use crate::mutations::{git_init_and_commit, run_build_dep_script};
use crate::node_oracle::{DST_RUNNER_JS, NodeOracleWorker};
use crate::timelines::warm_shared_cache;
use crate::tsc_oracle::{DST_TYPECHECK_JS, TscOracleWorker};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

static CACHE_INSTANCE_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TemplateKey {
    pub fallback_mode: FallbackMode,
    pub barrel_style: BarrelStyle,
    pub use_tsconfig_aliases: bool,
    pub use_file_narrowing: bool,
    pub declare_fs_impact_paths: bool,
    pub use_setup_file: bool,
    pub impact_pattern_idx: u8,
}

impl TemplateKey {
    pub fn from_shape(shape: &WorkspaceShape) -> Self {
        Self {
            fallback_mode: shape.fallback_mode,
            barrel_style: shape.barrel_style,
            use_tsconfig_aliases: shape.use_tsconfig_aliases,
            use_file_narrowing: shape.use_file_narrowing,
            declare_fs_impact_paths: shape.declare_fs_impact_paths,
            use_setup_file: shape.use_setup_file,
            impact_pattern_idx: shape.impact_pattern_idx % 3,
        }
    }

    fn dir_tag(self) -> String {
        let fb = match self.fallback_mode {
            FallbackMode::Empty => "e",
            FallbackMode::Partial => "p",
            FallbackMode::Complete => "c",
        };
        let bs = match self.barrel_style {
            BarrelStyle::DirectImport => "d",
            BarrelStyle::NamedReExport => "n",
            BarrelStyle::StarReExport => "s",
            BarrelStyle::NamespaceReExport => "ns",
        };
        format!(
            "tpl-{fb}-{bs}-a{}-f{}-i{}-s{}-p{}",
            u8::from(self.use_tsconfig_aliases),
            u8::from(self.use_file_narrowing),
            u8::from(self.declare_fs_impact_paths),
            u8::from(self.use_setup_file),
            self.impact_pattern_idx
        )
    }
}

struct CachedTemplate {
    ws_dir: PathBuf,
    cache_dir: PathBuf,
    baseline_sha: String,
    meta_template: GeneratedWorkspace,
}

struct SkeletonEntry {
    dir: PathBuf,
    meta: StaticSkeletonMeta,
}

pub struct ClonedScenarioBaseline {
    pub baseline_sha: String,
    pub generated: GeneratedWorkspace,
}

type TemplateSlot = Arc<OnceLock<Result<CachedTemplate, String>>>;

pub struct TemplateCache {
    root_dir: PathBuf,
    runner_script: PathBuf,
    typecheck_script: PathBuf,
    typescript_js: PathBuf,
    dad_bin: PathBuf,
    node_bin: PathBuf,
    skeleton: OnceLock<Result<SkeletonEntry, String>>,
    baseline_oracle_verified: AtomicBool,
    templates: Mutex<HashMap<TemplateKey, TemplateSlot>>,
}

impl TemplateCache {
    pub fn new(
        dad_bin: PathBuf,
        node_bin: PathBuf,
        typescript_js: PathBuf,
    ) -> Result<Self, String> {
        let seq = CACHE_INSTANCE_SEQ.fetch_add(1, Ordering::Relaxed);
        let root_dir =
            std::env::temp_dir().join(format!("dads-dst-tpl-cache-{}-{seq}", std::process::id()));
        let _ = fs::remove_dir_all(&root_dir);
        fs::create_dir_all(&root_dir)
            .map_err(|e| format!("create template cache root {}: {e}", root_dir.display()))?;
        let runner_script = root_dir.join("dst-runner.mjs");
        let typecheck_script = root_dir.join("dst-typecheck.mjs");
        fs::write(&runner_script, DST_RUNNER_JS)
            .map_err(|e| format!("write shared dst-runner.mjs: {e}"))?;
        fs::write(&typecheck_script, DST_TYPECHECK_JS)
            .map_err(|e| format!("write shared dst-typecheck.mjs: {e}"))?;
        Ok(Self {
            root_dir,
            runner_script,
            typecheck_script,
            typescript_js,
            dad_bin,
            node_bin,
            skeleton: OnceLock::new(),
            baseline_oracle_verified: AtomicBool::new(false),
            templates: Mutex::new(HashMap::new()),
        })
    }

    pub fn clone_for_scenario(
        &self,
        shape: &WorkspaceShape,
        dest_ws: &Path,
        dest_cache: &Path,
        oracle: &mut NodeOracleWorker,
        tsc_oracle: &mut TscOracleWorker,
    ) -> Result<ClonedScenarioBaseline, String> {
        let key = TemplateKey::from_shape(shape);
        let cell = {
            let mut guard = self
                .templates
                .lock()
                .map_err(|_| "template cache mutex poisoned".to_owned())?;
            Arc::clone(
                guard
                    .entry(key)
                    .or_insert_with(|| Arc::new(OnceLock::new())),
            )
        };
        let entry_res = cell.get_or_init(|| self.build_template(shape, key, oracle, tsc_oracle));
        let entry = entry_res.as_ref().map_err(Clone::clone)?;

        clone_dir(&entry.ws_dir, dest_ws)?;
        clone_dir(&entry.cache_dir, dest_cache)?;

        let mut generated = entry.meta_template.clone();
        generated.shape = shape.clone();
        Ok(ClonedScenarioBaseline {
            baseline_sha: entry.baseline_sha.clone(),
            generated,
        })
    }

    fn get_or_build_skeleton(&self) -> Result<&SkeletonEntry, String> {
        let res = self.skeleton.get_or_init(|| {
            let dir = self.root_dir.join("skeleton");
            fs::create_dir_all(&dir).map_err(|e| format!("mkdir skeleton: {e}"))?;
            let meta = write_static_skeleton(&dir)?;
            run_build_dep_script(&self.node_bin, &dir)?;
            Ok(SkeletonEntry { dir, meta })
        });
        res.as_ref().map_err(Clone::clone)
    }

    fn build_template(
        &self,
        shape: &WorkspaceShape,
        key: TemplateKey,
        oracle: &mut NodeOracleWorker,
        tsc_oracle: &mut TscOracleWorker,
    ) -> Result<CachedTemplate, String> {
        let skeleton = self.get_or_build_skeleton()?;
        let tpl_root = self.root_dir.join(key.dir_tag());
        fs::create_dir_all(&tpl_root)
            .map_err(|e| format!("mkdir template {}: {e}", tpl_root.display()))?;
        let ws_dir = tpl_root.join("ws");
        let cache_dir = tpl_root.join("shared-cache");
        fs::create_dir_all(&cache_dir).map_err(|e| format!("mkdir tpl cache: {e}"))?;
        fs::write(tpl_root.join("external-flag.txt"), "ok\n")
            .map_err(|e| format!("write tpl external flag: {e}"))?;

        clone_dir(&skeleton.dir, &ws_dir)?;
        write_shape_overlay(&ManifestInputs {
            root: &ws_dir,
            runner_script: &self.runner_script,
            typecheck_script: &self.typecheck_script,
            typescript_js: &self.typescript_js,
            node_bin: &self.node_bin,
            shape,
        })?;
        let baseline_sha = git_init_and_commit(&ws_dir, "dst baseline")?;
        let generated = build_generated_metadata(shape, &skeleton.meta);

        if !self.baseline_oracle_verified.swap(true, Ordering::SeqCst) {
            let baseline_oracle = oracle.evaluate(&ws_dir, &generated.oracle_tests)?;
            for (file, outcome) in &baseline_oracle {
                if !outcome.ok {
                    return Err(format!(
                        "baseline node oracle failed for {file}: {:?}",
                        outcome.error
                    ));
                }
            }
            for (task_id, tsconfig_rel) in &generated.typecheck_tasks {
                let tc = tsc_oracle.check(&ws_dir, tsconfig_rel)?;
                if !tc.passed {
                    return Err(format!(
                        "baseline tsc oracle failed for {task_id}: {:?}",
                        tc.errors
                    ));
                }
            }
        }
        warm_shared_cache(&self.dad_bin, &ws_dir, &cache_dir, self.node_bin.parent())?;

        Ok(CachedTemplate {
            ws_dir,
            cache_dir,
            baseline_sha,
            meta_template: generated,
        })
    }
}

impl Drop for TemplateCache {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root_dir);
    }
}

/// Clones `src` to a non-existent `dst` directory using APFS `cp -cR` on macOS,
/// falling back to a recursive copy preserving file permissions.
pub fn clone_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if dst.exists() {
        fs::remove_dir_all(dst)
            .map_err(|e| format!("clear clone target {}: {e}", dst.display()))?;
    }
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("cp").arg("-cR").arg(src).arg(dst).status();
        if matches!(status, Ok(s) if s.success()) {
            return Ok(());
        }
        let _ = fs::remove_dir_all(dst);
    }
    copy_dir_recursive(src, dst)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
    let entries = fs::read_dir(src).map_err(|e| format!("read_dir {}: {e}", src.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("dir entry {}: {e}", src.display()))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let meta = fs::symlink_metadata(&src_path)
            .map_err(|e| format!("stat {}: {e}", src_path.display()))?;
        if meta.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if meta.is_file() {
            fs::copy(&src_path, &dst_path).map_err(|e| {
                format!("copy {} -> {}: {e}", src_path.display(), dst_path.display())
            })?;
            let _ = fs::set_permissions(&dst_path, meta.permissions());
        }
    }
    Ok(())
}
