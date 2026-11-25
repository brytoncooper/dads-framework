//! Scenario topology, mutation catalog, and report data structures for DST sweeps.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FallbackMode {
    /// Empty `fallbackDependencies: []` (matches Command's real discovered projects).
    Empty,
    /// Only half of real cross-project dependencies declared.
    Partial,
    /// Every cross-project dependency declared.
    Complete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BarrelStyle {
    DirectImport,
    NamedReExport,
    StarReExport,
    NamespaceReExport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MutationKind {
    PureExportValue,
    UnusedPureExport,
    PrivateHelperUsedByExport,
    ImpureExportInitializerAssign,
    ImpureExportInitializerCall,
    HelperCalledByImpureInitializer,
    ClassStaticBlockSideEffect,
    TopLevelStatementSideEffect,
    MixedExportAndUnusedRuntimeImport,
    CommentOrTypeOnlyEdit,
    StaticJsonImport,
    FsReadFileSyncNewUrl,
    FsReaddirSyncExistingFile,
    FsReaddirSyncAddedFile,
    SetupFileMutation,
    TsconfigAliasRetarget,
    ImpactPathsWithWarmCache,
    UpstreamLibWithWarmCacheAndPlanFile,
    UncertainUpstreamWithEmptyFallback,
    CorruptSharedCacheBlob,
}

impl MutationKind {
    pub const ALL: &'static [Self] = &[
        Self::PureExportValue,
        Self::UnusedPureExport,
        Self::PrivateHelperUsedByExport,
        Self::ImpureExportInitializerAssign,
        Self::ImpureExportInitializerCall,
        Self::HelperCalledByImpureInitializer,
        Self::ClassStaticBlockSideEffect,
        Self::TopLevelStatementSideEffect,
        Self::MixedExportAndUnusedRuntimeImport,
        Self::CommentOrTypeOnlyEdit,
        Self::StaticJsonImport,
        Self::FsReadFileSyncNewUrl,
        Self::FsReaddirSyncExistingFile,
        Self::FsReaddirSyncAddedFile,
        Self::SetupFileMutation,
        Self::TsconfigAliasRetarget,
        Self::ImpactPathsWithWarmCache,
        Self::UpstreamLibWithWarmCacheAndPlanFile,
        Self::UncertainUpstreamWithEmptyFallback,
        Self::CorruptSharedCacheBlob,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::PureExportValue => "pure-export-value",
            Self::UnusedPureExport => "unused-pure-export",
            Self::PrivateHelperUsedByExport => "private-helper-used-by-export",
            Self::ImpureExportInitializerAssign => "impure-export-initializer-assign",
            Self::ImpureExportInitializerCall => "impure-export-initializer-call",
            Self::HelperCalledByImpureInitializer => "helper-called-by-impure-initializer",
            Self::ClassStaticBlockSideEffect => "class-static-block-side-effect",
            Self::TopLevelStatementSideEffect => "top-level-statement-side-effect",
            Self::MixedExportAndUnusedRuntimeImport => "mixed-export-and-unused-runtime-import",
            Self::CommentOrTypeOnlyEdit => "comment-or-type-only-edit",
            Self::StaticJsonImport => "static-json-import",
            Self::FsReadFileSyncNewUrl => "fs-read-file-sync-new-url",
            Self::FsReaddirSyncExistingFile => "fs-readdir-sync-existing-file",
            Self::FsReaddirSyncAddedFile => "fs-readdir-sync-added-file",
            Self::SetupFileMutation => "setup-file-mutation",
            Self::TsconfigAliasRetarget => "tsconfig-alias-retarget",
            Self::ImpactPathsWithWarmCache => "impact-paths-with-warm-cache",
            Self::UpstreamLibWithWarmCacheAndPlanFile => {
                "upstream-lib-with-warm-cache-and-plan-file"
            }
            Self::UncertainUpstreamWithEmptyFallback => "uncertain-upstream-with-empty-fallback",
            Self::CorruptSharedCacheBlob => "corrupt-shared-cache-blob",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|k| k.as_str() == raw)
    }

    pub fn is_precision_noop(self) -> bool {
        matches!(self, Self::UnusedPureExport | Self::CommentOrTypeOnlyEdit)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceShape {
    pub seed: u64,
    pub fallback_mode: FallbackMode,
    pub barrel_style: BarrelStyle,
    pub use_tsconfig_aliases: bool,
    pub use_file_narrowing: bool,
    pub declare_fs_impact_paths: bool,
    pub use_setup_file: bool,
    pub commit_before_plan: bool,
    pub use_plan_file: bool,
    pub use_shared_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundnessFailure {
    pub seed: u64,
    pub step: usize,
    pub mutation: MutationKind,
    pub kind: String,
    pub task_id: String,
    pub test_file: String,
    pub detail: String,
    pub shape: WorkspaceShape,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kept_dir: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationStats {
    pub steps: usize,
    pub oracle_failures: usize,
    pub soundness_misses: usize,
    pub stale_cache_hits: usize,
    pub precision_checks: usize,
    pub precision_skips: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DstSummary {
    pub scenarios_run: usize,
    pub steps_executed: usize,
    pub oracle_failures_total: usize,
    pub soundness_misses_total: usize,
    pub stale_cache_hits_total: usize,
    pub cache_integrity_violations: usize,
    pub harness_errors: usize,
    pub precision_checks_total: usize,
    pub precision_skips_total: usize,
    pub elapsed_ms: u64,
    pub by_mutation: BTreeMap<String, MutationStats>,
    pub sample_failures: Vec<SoundnessFailure>,
}
