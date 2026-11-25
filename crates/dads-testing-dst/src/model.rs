//! Scenario topology, 93-family mutation catalog types, and report structures for DST sweeps.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FallbackMode {
    /// Empty `fallbackDependencies: []` (matches Command's real discovered projects).
    Empty,
    /// Only half of real cross-project dependencies declared.
    Partial,
    /// Every cross-project dependency declared.
    Complete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
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
    // --- Core 20 ---
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
    // --- JS/TS Language & Module Evaluation (21) ---
    DefaultExportMutation,
    EscapedNamespaceMutation,
    CommonJsRequireMutation,
    MultiHopAliasedReExport,
    TsEnumMutation,
    FunctionOverloadBodyMutation,
    ClassExtendsSuperclassMutation,
    ImpureStaticClassField,
    DestructuredExportMutation,
    MultiDeclaratorExportMutation,
    SeparateDeclBareExport,
    LiveMutableExportLet,
    ComputedKeyOrSpreadSideEffect,
    DeleteBareSideEffectImport,
    ZeroExportSideEffectModuleEdit,
    TopLevelAwaitSideEffect,
    CrossModuleRegistryMutation,
    PureAnnotationImpureArgTrap,
    CircularImportMutation,
    StaticDynamicImportMutation,
    AsiWhitespaceNewlineMutation,
    // --- Filesystem, Resolution & Git (8) ---
    TransitiveHelperFsRead,
    FsPromisesExistsOrNestedDir,
    FsReaddirSyncDeletedFile,
    TsJsExtensionMapping,
    FileShadowingAddition,
    TransitiveSetupFileChain,
    TsconfigNonPathsOptionEdit,
    PackageSubpathImportsEdit,
    // --- Stateful Store, Cache & CI Topology (9) ---
    ChainedDirtyIncrementalSnapshot,
    MultiBranchSharedL2Cache,
    TaskEnvOrArgsManifestEdit,
    SymlinkInImpactPaths,
    DeletedImpactPathsGlobFile,
    AlwaysModeNeverCached,
    DependsOnPrerequisiteChain,
    ShardedPlanUnionCompleteness,
    MixedPassFailBatchIsolation,
    // --- Section A: Hardened 0.9.0 Soundness & Caching Holes (10) ---
    ObjectFreezeSharedIdent,
    ImplicitCoercionSideEffect,
    TopLevelLoadThrowPureTrap,
    ExistsSyncMissingAtBaseline,
    ReaddirSyncEmptyOrOvercapDir,
    CrossFileFsHelperAndUnresolved,
    ExtendedFsAndExecReadApis,
    GitignoredImpactPathsGlob,
    UpstreamPackageExportsAndNestedTsconfig,
    NonRootAndDotenvConfigFiles,
    // --- Section B: Uncovered dad-test Subsystems (#71-#78) ---
    TypecheckTypeOnlyAndAmbientDts,
    ImportMetaGlobAddEditDelete,
    SqlMigrationImpactAndCache,
    LockfileAndConditionalExports,
    TsxJsxAndBundlerQueryAssets,
    VitestViMockHoistedAndConfigSetup,
    ModuleBoundariesViolationAndFix,
    RemoteHttpCacheFaultInjection,
    // --- Section C: Additional JS/TS Language & Purity Traps (#79-#85) ---
    DefaultReexportGymnastics,
    ClassAndMemberDecoratorsSideEffect,
    TaggedTemplateLiteralSideEffect,
    TsNamespaceDeclarationMergingConstEnum,
    NewCustomClassAndPureBuiltinEdge,
    PureFactoriesPrecisionAndImpureArg,
    DiamondExportStarShadowing,
    // --- Section D: File Lifecycle, Paths, Git, OS, Concurrency & CLI (#86-#95) ---
    NextjsSpecialPathChars,
    CaseOnlyFileRename,
    NewUntrackedFailingTestFile,
    FileDeleteGitMvAndDeletionHunk,
    StagedVsUnstagedSplitDiff,
    MultiCommitMergeDetachedAndWorktree,
    EncodingCrlfBomBinaryChmod,
    ConcurrentParallelCacheWriters,
    SameSizeSameMsEditAndEnvDrift,
    CliFiltersWeightedShardAndStalePlanFile,
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
    #[serde(default)]
    pub impact_pattern_idx: u8,
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
