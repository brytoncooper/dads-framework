//! Complete 95-family `MutationKind` catalog, slug mapping, and classification helpers.

use crate::model::MutationKind;

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
        Self::DefaultExportMutation,
        Self::EscapedNamespaceMutation,
        Self::CommonJsRequireMutation,
        Self::MultiHopAliasedReExport,
        Self::TsEnumMutation,
        Self::FunctionOverloadBodyMutation,
        Self::ClassExtendsSuperclassMutation,
        Self::ImpureStaticClassField,
        Self::DestructuredExportMutation,
        Self::MultiDeclaratorExportMutation,
        Self::SeparateDeclBareExport,
        Self::LiveMutableExportLet,
        Self::ComputedKeyOrSpreadSideEffect,
        Self::DeleteBareSideEffectImport,
        Self::ZeroExportSideEffectModuleEdit,
        Self::TopLevelAwaitSideEffect,
        Self::CrossModuleRegistryMutation,
        Self::PureAnnotationImpureArgTrap,
        Self::CircularImportMutation,
        Self::StaticDynamicImportMutation,
        Self::AsiWhitespaceNewlineMutation,
        Self::TransitiveHelperFsRead,
        Self::FsPromisesExistsOrNestedDir,
        Self::FsReaddirSyncDeletedFile,
        Self::TsJsExtensionMapping,
        Self::FileShadowingAddition,
        Self::TransitiveSetupFileChain,
        Self::TsconfigNonPathsOptionEdit,
        Self::PackageSubpathImportsEdit,
        Self::ChainedDirtyIncrementalSnapshot,
        Self::MultiBranchSharedL2Cache,
        Self::TaskEnvOrArgsManifestEdit,
        Self::SymlinkInImpactPaths,
        Self::DeletedImpactPathsGlobFile,
        Self::AlwaysModeNeverCached,
        Self::DependsOnPrerequisiteChain,
        Self::ShardedPlanUnionCompleteness,
        Self::MixedPassFailBatchIsolation,
        Self::ObjectFreezeSharedIdent,
        Self::ImplicitCoercionSideEffect,
        Self::TopLevelLoadThrowPureTrap,
        Self::ExistsSyncMissingAtBaseline,
        Self::ReaddirSyncEmptyOrOvercapDir,
        Self::CrossFileFsHelperAndUnresolved,
        Self::ExtendedFsAndExecReadApis,
        Self::GitignoredImpactPathsGlob,
        Self::UpstreamPackageExportsAndNestedTsconfig,
        Self::NonRootAndDotenvConfigFiles,
        Self::UndeclaredDynamicFsReadEnforced,
        Self::AuditFixRemediatesDynamicRead,
        Self::TypecheckTypeOnlyAndAmbientDts,
        Self::ImportMetaGlobAddEditDelete,
        Self::SqlMigrationImpactAndCache,
        Self::LockfileAndConditionalExports,
        Self::TsxJsxAndBundlerQueryAssets,
        Self::VitestViMockHoistedAndConfigSetup,
        Self::ModuleBoundariesViolationAndFix,
        Self::RemoteHttpCacheFaultInjection,
        Self::DefaultReexportGymnastics,
        Self::ClassAndMemberDecoratorsSideEffect,
        Self::TaggedTemplateLiteralSideEffect,
        Self::TsNamespaceDeclarationMergingConstEnum,
        Self::NewCustomClassAndPureBuiltinEdge,
        Self::PureFactoriesPrecisionAndImpureArg,
        Self::DiamondExportStarShadowing,
        Self::NextjsSpecialPathChars,
        Self::CaseOnlyFileRename,
        Self::NewUntrackedFailingTestFile,
        Self::FileDeleteGitMvAndDeletionHunk,
        Self::StagedVsUnstagedSplitDiff,
        Self::MultiCommitMergeDetachedAndWorktree,
        Self::EncodingCrlfBomBinaryChmod,
        Self::ConcurrentParallelCacheWriters,
        Self::SameSizeSameMsEditAndEnvDrift,
        Self::CliFiltersWeightedShardAndStalePlanFile,
    ];

    pub fn as_str(self) -> &'static str {
        as_str_base(self).unwrap_or_else(|| as_str_expanded(self))
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|k| k.as_str() == raw)
    }

    pub fn is_precision_noop(self) -> bool {
        matches!(self, Self::UnusedPureExport | Self::CommentOrTypeOnlyEdit)
    }

    pub fn uses_tsc_oracle(self) -> bool {
        matches!(self, Self::TypecheckTypeOnlyAndAmbientDts)
    }

    pub fn uses_boundaries_check(self) -> bool {
        matches!(self, Self::ModuleBoundariesViolationAndFix)
    }

    pub fn uses_remote_cache(self) -> bool {
        matches!(self, Self::RemoteHttpCacheFaultInjection)
    }

    pub fn is_read_guard(self) -> bool {
        matches!(
            self,
            Self::UndeclaredDynamicFsReadEnforced | Self::AuditFixRemediatesDynamicRead
        )
    }

    pub fn is_section_b(self) -> bool {
        matches!(
            self,
            Self::TypecheckTypeOnlyAndAmbientDts
                | Self::ImportMetaGlobAddEditDelete
                | Self::SqlMigrationImpactAndCache
                | Self::LockfileAndConditionalExports
                | Self::TsxJsxAndBundlerQueryAssets
                | Self::VitestViMockHoistedAndConfigSetup
                | Self::ModuleBoundariesViolationAndFix
                | Self::RemoteHttpCacheFaultInjection
        )
    }

    pub fn is_section_c(self) -> bool {
        matches!(
            self,
            Self::DefaultReexportGymnastics
                | Self::ClassAndMemberDecoratorsSideEffect
                | Self::TaggedTemplateLiteralSideEffect
                | Self::TsNamespaceDeclarationMergingConstEnum
                | Self::NewCustomClassAndPureBuiltinEdge
                | Self::PureFactoriesPrecisionAndImpureArg
                | Self::DiamondExportStarShadowing
        )
    }

    pub fn is_section_d(self) -> bool {
        matches!(
            self,
            Self::NextjsSpecialPathChars
                | Self::CaseOnlyFileRename
                | Self::NewUntrackedFailingTestFile
                | Self::FileDeleteGitMvAndDeletionHunk
                | Self::StagedVsUnstagedSplitDiff
                | Self::MultiCommitMergeDetachedAndWorktree
                | Self::EncodingCrlfBomBinaryChmod
                | Self::ConcurrentParallelCacheWriters
                | Self::SameSizeSameMsEditAndEnvDrift
                | Self::CliFiltersWeightedShardAndStalePlanFile
        )
    }
}

fn as_str_base(kind: MutationKind) -> Option<&'static str> {
    let slug = match kind {
        MutationKind::PureExportValue => "pure-export-value",
        MutationKind::UnusedPureExport => "unused-pure-export",
        MutationKind::PrivateHelperUsedByExport => "private-helper-used-by-export",
        MutationKind::ImpureExportInitializerAssign => "impure-export-initializer-assign",
        MutationKind::ImpureExportInitializerCall => "impure-export-initializer-call",
        MutationKind::HelperCalledByImpureInitializer => "helper-called-by-impure-initializer",
        MutationKind::ClassStaticBlockSideEffect => "class-static-block-side-effect",
        MutationKind::TopLevelStatementSideEffect => "top-level-statement-side-effect",
        MutationKind::MixedExportAndUnusedRuntimeImport => "mixed-export-and-unused-runtime-import",
        MutationKind::CommentOrTypeOnlyEdit => "comment-or-type-only-edit",
        MutationKind::StaticJsonImport => "static-json-import",
        MutationKind::FsReadFileSyncNewUrl => "fs-read-file-sync-new-url",
        MutationKind::FsReaddirSyncExistingFile => "fs-readdir-sync-existing-file",
        MutationKind::FsReaddirSyncAddedFile => "fs-readdir-sync-added-file",
        MutationKind::SetupFileMutation => "setup-file-mutation",
        MutationKind::TsconfigAliasRetarget => "tsconfig-alias-retarget",
        MutationKind::ImpactPathsWithWarmCache => "impact-paths-with-warm-cache",
        MutationKind::UpstreamLibWithWarmCacheAndPlanFile => {
            "upstream-lib-with-warm-cache-and-plan-file"
        }
        MutationKind::UncertainUpstreamWithEmptyFallback => {
            "uncertain-upstream-with-empty-fallback"
        }
        MutationKind::CorruptSharedCacheBlob => "corrupt-shared-cache-blob",
        MutationKind::DefaultExportMutation => "default-export-mutation",
        MutationKind::EscapedNamespaceMutation => "escaped-namespace-mutation",
        MutationKind::CommonJsRequireMutation => "commonjs-require-mutation",
        MutationKind::MultiHopAliasedReExport => "multi-hop-aliased-reexport",
        MutationKind::TsEnumMutation => "ts-enum-mutation",
        MutationKind::FunctionOverloadBodyMutation => "function-overload-body-mutation",
        MutationKind::ClassExtendsSuperclassMutation => "class-extends-superclass-mutation",
        MutationKind::ImpureStaticClassField => "impure-static-class-field",
        MutationKind::DestructuredExportMutation => "destructured-export-mutation",
        MutationKind::MultiDeclaratorExportMutation => "multi-declarator-export-mutation",
        MutationKind::SeparateDeclBareExport => "separate-decl-bare-export",
        MutationKind::LiveMutableExportLet => "live-mutable-export-let",
        MutationKind::ComputedKeyOrSpreadSideEffect => "computed-key-or-spread-side-effect",
        MutationKind::DeleteBareSideEffectImport => "delete-bare-side-effect-import",
        MutationKind::ZeroExportSideEffectModuleEdit => "zero-export-side-effect-module-edit",
        MutationKind::TopLevelAwaitSideEffect => "top-level-await-side-effect",
        MutationKind::CrossModuleRegistryMutation => "cross-module-registry-mutation",
        MutationKind::PureAnnotationImpureArgTrap => "pure-annotation-impure-arg-trap",
        MutationKind::CircularImportMutation => "circular-import-mutation",
        MutationKind::StaticDynamicImportMutation => "static-dynamic-import-mutation",
        MutationKind::AsiWhitespaceNewlineMutation => "asi-whitespace-newline-mutation",
        MutationKind::TransitiveHelperFsRead => "transitive-helper-fs-read",
        MutationKind::FsPromisesExistsOrNestedDir => "fs-promises-exists-or-nested-dir",
        MutationKind::FsReaddirSyncDeletedFile => "fs-readdir-sync-deleted-file",
        MutationKind::TsJsExtensionMapping => "ts-js-extension-mapping",
        MutationKind::FileShadowingAddition => "file-shadowing-addition",
        MutationKind::TransitiveSetupFileChain => "transitive-setup-file-chain",
        MutationKind::TsconfigNonPathsOptionEdit => "tsconfig-non-paths-option-edit",
        MutationKind::PackageSubpathImportsEdit => "package-subpath-imports-edit",
        MutationKind::ChainedDirtyIncrementalSnapshot => "chained-dirty-incremental-snapshot",
        MutationKind::MultiBranchSharedL2Cache => "multi-branch-shared-l2-cache",
        MutationKind::TaskEnvOrArgsManifestEdit => "task-env-or-args-manifest-edit",
        MutationKind::SymlinkInImpactPaths => "symlink-in-impact-paths",
        MutationKind::DeletedImpactPathsGlobFile => "deleted-impact-paths-glob-file",
        MutationKind::AlwaysModeNeverCached => "always-mode-never-cached",
        MutationKind::DependsOnPrerequisiteChain => "depends-on-prerequisite-chain",
        MutationKind::ShardedPlanUnionCompleteness => "sharded-plan-union-completeness",
        MutationKind::MixedPassFailBatchIsolation => "mixed-pass-fail-batch-isolation",
        _ => return None,
    };
    Some(slug)
}

fn as_str_expanded(kind: MutationKind) -> &'static str {
    match kind {
        MutationKind::ObjectFreezeSharedIdent => "object-freeze-shared-ident",
        MutationKind::ImplicitCoercionSideEffect => "implicit-coercion-side-effect",
        MutationKind::TopLevelLoadThrowPureTrap => "top-level-load-throw-pure-trap",
        MutationKind::ExistsSyncMissingAtBaseline => "exists-sync-missing-at-baseline",
        MutationKind::ReaddirSyncEmptyOrOvercapDir => "readdir-sync-empty-or-overcap-dir",
        MutationKind::CrossFileFsHelperAndUnresolved => "cross-file-fs-helper-and-unresolved",
        MutationKind::ExtendedFsAndExecReadApis => "extended-fs-and-exec-read-apis",
        MutationKind::GitignoredImpactPathsGlob => "gitignored-impact-paths-glob",
        MutationKind::UpstreamPackageExportsAndNestedTsconfig => {
            "upstream-package-exports-and-nested-tsconfig"
        }
        MutationKind::NonRootAndDotenvConfigFiles => "non-root-and-dotenv-config-files",
        MutationKind::UndeclaredDynamicFsReadEnforced => "undeclared-dynamic-fs-read-enforced",
        MutationKind::AuditFixRemediatesDynamicRead => "audit-fix-remediates-dynamic-read",
        MutationKind::TypecheckTypeOnlyAndAmbientDts => "typecheck-type-only-and-ambient-dts",
        MutationKind::ImportMetaGlobAddEditDelete => "import-meta-glob-add-edit-delete",
        MutationKind::SqlMigrationImpactAndCache => "sql-migration-impact-and-cache",
        MutationKind::LockfileAndConditionalExports => "lockfile-and-conditional-exports",
        MutationKind::TsxJsxAndBundlerQueryAssets => "tsx-jsx-and-bundler-query-assets",
        MutationKind::VitestViMockHoistedAndConfigSetup => {
            "vitest-vi-mock-hoisted-and-config-setup"
        }
        MutationKind::ModuleBoundariesViolationAndFix => "module-boundaries-violation-and-fix",
        MutationKind::RemoteHttpCacheFaultInjection => "remote-http-cache-fault-injection",
        MutationKind::DefaultReexportGymnastics => "default-reexport-gymnastics",
        MutationKind::ClassAndMemberDecoratorsSideEffect => {
            "class-and-member-decorators-side-effect"
        }
        MutationKind::TaggedTemplateLiteralSideEffect => "tagged-template-literal-side-effect",
        MutationKind::TsNamespaceDeclarationMergingConstEnum => {
            "ts-namespace-declaration-merging-const-enum"
        }
        MutationKind::NewCustomClassAndPureBuiltinEdge => "new-custom-class-and-pure-builtin-edge",
        MutationKind::PureFactoriesPrecisionAndImpureArg => {
            "pure-factories-precision-and-impure-arg"
        }
        MutationKind::DiamondExportStarShadowing => "diamond-export-star-shadowing",
        MutationKind::NextjsSpecialPathChars => "nextjs-special-path-chars",
        MutationKind::CaseOnlyFileRename => "case-only-file-rename",
        MutationKind::NewUntrackedFailingTestFile => "new-untracked-failing-test-file",
        MutationKind::FileDeleteGitMvAndDeletionHunk => "file-delete-git-mv-and-deletion-hunk",
        MutationKind::StagedVsUnstagedSplitDiff => "staged-vs-unstaged-split-diff",
        MutationKind::MultiCommitMergeDetachedAndWorktree => {
            "multi-commit-merge-detached-and-worktree"
        }
        MutationKind::EncodingCrlfBomBinaryChmod => "encoding-crlf-bom-binary-chmod",
        MutationKind::ConcurrentParallelCacheWriters => "concurrent-parallel-cache-writers",
        MutationKind::SameSizeSameMsEditAndEnvDrift => "same-size-same-ms-edit-and-env-drift",
        MutationKind::CliFiltersWeightedShardAndStalePlanFile => {
            "cli-filters-weighted-shard-and-stale-plan-file"
        }
        _ => "unknown",
    }
}
