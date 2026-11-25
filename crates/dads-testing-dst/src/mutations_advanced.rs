//! Advanced 38 mutation families: JS/TS constructs, FS APIs, resolution, and stateful CI timelines.

use crate::model::{MutationKind, WorkspaceShape};
use crate::mutations::{AppliedMutation, replace_once};
use std::fs;
use std::path::Path;

pub struct AdvancedMutationPaths<'a> {
    pub workspace_dir: &'a Path,
    pub external_flag_path: &'a Path,
    pub symlink_target_path: &'a Path,
}

pub fn apply_advanced_mutation(
    paths: &AdvancedMutationPaths<'_>,
    shape: &WorkspaceShape,
    kind: MutationKind,
    step_idx: usize,
) -> Result<AppliedMutation, String> {
    match kind {
        MutationKind::DefaultExportMutation
        | MutationKind::EscapedNamespaceMutation
        | MutationKind::CommonJsRequireMutation
        | MutationKind::MultiHopAliasedReExport
        | MutationKind::TsEnumMutation
        | MutationKind::FunctionOverloadBodyMutation
        | MutationKind::ClassExtendsSuperclassMutation
        | MutationKind::ImpureStaticClassField
        | MutationKind::DestructuredExportMutation
        | MutationKind::MultiDeclaratorExportMutation
        | MutationKind::SeparateDeclBareExport
        | MutationKind::LiveMutableExportLet
        | MutationKind::ComputedKeyOrSpreadSideEffect
        | MutationKind::DeleteBareSideEffectImport
        | MutationKind::ZeroExportSideEffectModuleEdit
        | MutationKind::TopLevelAwaitSideEffect
        | MutationKind::CrossModuleRegistryMutation
        | MutationKind::PureAnnotationImpureArgTrap
        | MutationKind::CircularImportMutation
        | MutationKind::StaticDynamicImportMutation
        | MutationKind::AsiWhitespaceNewlineMutation => {
            apply_lang_mutation(paths.workspace_dir, kind)
        }
        MutationKind::TransitiveHelperFsRead
        | MutationKind::FsPromisesExistsOrNestedDir
        | MutationKind::FsReaddirSyncDeletedFile
        | MutationKind::TsJsExtensionMapping
        | MutationKind::FileShadowingAddition
        | MutationKind::TransitiveSetupFileChain
        | MutationKind::TsconfigNonPathsOptionEdit
        | MutationKind::PackageSubpathImportsEdit => {
            apply_fs_or_resolution_mutation(paths.workspace_dir, shape, kind, step_idx)
        }
        _ => apply_topology_mutation(paths, kind),
    }
}

fn apply_lang_mutation(root: &Path, kind: MutationKind) -> Result<AppliedMutation, String> {
    match kind {
        MutationKind::DefaultExportMutation => {
            replace_once(root, "lang/default-exp.ts", "n * 2", "n * 5")?;
        }
        MutationKind::EscapedNamespaceMutation => {
            replace_once(root, "lang/ns-source.ts", "nsBeta = 3", "nsBeta = 9")?;
        }
        MutationKind::CommonJsRequireMutation => {
            replace_once(root, "lang/legacy.cjs", "legacyRate: 2", "legacyRate: 9")?;
        }
        MutationKind::MultiHopAliasedReExport => {
            replace_once(root, "lang/hop-a.ts", "origVal = 2", "origVal = 9")?;
        }
        MutationKind::TsEnumMutation => {
            replace_once(root, "lang/enums.ts", "Active = 1", "Active = 9")?;
        }
        MutationKind::FunctionOverloadBodyMutation => {
            replace_once(root, "lang/overloads.ts", "x * 2", "x * 5")?;
        }
        MutationKind::ClassExtendsSuperclassMutation => {
            replace_once(root, "lang/base-class.ts", "return 2;", "return 5;")?;
        }
        MutationKind::ImpureStaticClassField => {
            replace_once(root, "lang/static-field.ts", "setSt(2)", "setSt(5)")?;
        }
        MutationKind::DestructuredExportMutation => {
            replace_once(root, "lang/decls.ts", "a: 2, b: 3", "a: 9, b: 3")?;
        }
        MutationKind::MultiDeclaratorExportMutation => {
            replace_once(root, "lang/decls.ts", "multiA = 2", "multiA = 9")?;
        }
        MutationKind::SeparateDeclBareExport => {
            replace_once(root, "lang/decls.ts", "hiddenVal = 2", "hiddenVal = 9")?;
        }
        MutationKind::LiveMutableExportLet => {
            replace_once(root, "lang/decls.ts", "mutableRate = 2", "mutableRate = 9")?;
        }
        MutationKind::ComputedKeyOrSpreadSideEffect => {
            replace_once(root, "lang/computed-prop.ts", "keyFn(2)", "keyFn(5)")?;
        }
        MutationKind::DeleteBareSideEffectImport => {
            replace_once(
                root,
                "lang/se-bridge.ts",
                "import \"./required-init.ts\";\n",
                "",
            )?;
        }
        MutationKind::ZeroExportSideEffectModuleEdit => {
            replace_once(root, "lang/zero-export-se.ts", "= 2;", "= 5;")?;
        }
        MutationKind::TopLevelAwaitSideEffect => {
            replace_once(root, "lang/top-await.ts", "loadAw(2)", "loadAw(5)")?;
        }
        MutationKind::CrossModuleRegistryMutation => {
            replace_once(
                root,
                "lang/registry-mutator.ts",
                "registry.set(\"tax\", 2)",
                "registry.set(\"tax\", 5)",
            )?;
        }
        MutationKind::PureAnnotationImpureArgTrap => {
            replace_once(root, "lang/pure-trap.ts", "impureArg(2)", "impureArg(5)")?;
        }
        MutationKind::CircularImportMutation => {
            replace_once(root, "lang/cycle-a.ts", "cycleBase = 2", "cycleBase = 9")?;
        }
        MutationKind::StaticDynamicImportMutation => {
            replace_once(root, "lang/lazy.ts", "lazyFactor = 2", "lazyFactor = 9")?;
        }
        MutationKind::AsiWhitespaceNewlineMutation => {
            replace_once(root, "lang/asi.ts", "return 2;", "return\n  2;")?;
        }
        _ => {}
    }
    Ok(AppliedMutation::default())
}

fn apply_fs_or_resolution_mutation(
    root: &Path,
    shape: &WorkspaceShape,
    kind: MutationKind,
    step_idx: usize,
) -> Result<AppliedMutation, String> {
    match kind {
        MutationKind::TransitiveHelperFsRead => {
            fs::write(root.join("settings/helper-disk.json"), "{\"limit\": 9}\n")
                .map_err(|e| format!("write helper-disk.json: {e}"))?;
        }
        MutationKind::FsPromisesExistsOrNestedDir => match step_idx % 3 {
            0 => fs::write(root.join("settings/async-limit.json"), "{\"limit\": 9}\n")
                .map_err(|e| format!("write async-limit.json: {e}"))?,
            1 => fs::remove_file(root.join("settings/sentinel.txt"))
                .map_err(|e| format!("remove sentinel.txt: {e}"))?,
            _ => fs::write(
                root.join("settings/nested-rules/sub/deep.txt"),
                "FORBIDDEN\n",
            )
            .map_err(|e| format!("write deep.txt: {e}"))?,
        },
        MutationKind::FsReaddirSyncDeletedFile => {
            fs::remove_file(root.join("settings/rules/rule-b.txt"))
                .map_err(|e| format!("remove rule-b.txt: {e}"))?;
        }
        MutationKind::TsJsExtensionMapping => {
            replace_once(
                root,
                "lang/js-ext-target.ts",
                "jsExtVal = 2",
                "jsExtVal = 9",
            )?;
        }
        MutationKind::FileShadowingAddition => {
            fs::write(
                root.join("lang/shadow.ts"),
                "export const shadowVal = 99;\n",
            )
            .map_err(|e| format!("write shadow.ts: {e}"))?;
        }
        MutationKind::TransitiveSetupFileChain => {
            if shape.use_setup_file {
                replace_once(root, "core/setup-const.ts", "\"ok\"", "\"broken\"")?;
            } else {
                replace_once(root, "core/math.ts", "=> 2;", "=> 7;")?;
            }
        }
        MutationKind::TsconfigNonPathsOptionEdit => {
            replace_once(
                root,
                "tsconfig.base.json",
                "\"baseUrl\": \".\"",
                "\"strict\": true,\n    \"baseUrl\": \".\"",
            )?;
            replace_once(
                root,
                "core/math.ts",
                "n * baseScale()",
                "n * baseScale() + 4",
            )?;
        }
        MutationKind::PackageSubpathImportsEdit => {
            replace_once(
                root,
                "lang/subpath-target.ts",
                "subpathVal = 2",
                "subpathVal = 9",
            )?;
        }
        _ => {}
    }
    Ok(AppliedMutation::default())
}

fn apply_topology_mutation(
    paths: &AdvancedMutationPaths<'_>,
    kind: MutationKind,
) -> Result<AppliedMutation, String> {
    let root = paths.workspace_dir;
    let mut out = AppliedMutation::default();
    match kind {
        MutationKind::ChainedDirtyIncrementalSnapshot => {
            out.chained_dirty_steps = true;
        }
        MutationKind::MultiBranchSharedL2Cache => {
            out.multi_branch_l2_cache = true;
        }
        MutationKind::TaskEnvOrArgsManifestEdit => {
            replace_once(
                root,
                "dads.testing.json",
                "\"DST_MODE\": \"safe\"",
                "\"DST_MODE\": \"broken\"",
            )?;
            out.oracle_env_override = Some((
                "adv-env/env-args.test.ts".to_owned(),
                "DST_MODE".to_owned(),
                "broken".to_owned(),
            ));
        }
        MutationKind::SymlinkInImpactPaths => {
            fs::write(
                paths.symlink_target_path,
                "{\"flag\": \"symlink-broken\"}\n",
            )
            .map_err(|e| format!("write symlink target: {e}"))?;
            let link_path = root.join("settings/impact-flag.json");
            let _ = fs::remove_file(&link_path);
            create_file_symlink(paths.symlink_target_path, &link_path)?;
        }
        MutationKind::DeletedImpactPathsGlobFile => {
            fs::remove_file(root.join("settings/impact-extra.json"))
                .map_err(|e| format!("remove impact-extra.json: {e}"))?;
            out.force_commit = true;
        }
        MutationKind::AlwaysModeNeverCached => {
            fs::write(paths.external_flag_path, "broken\n")
                .map_err(|e| format!("write external flag: {e}"))?;
        }
        MutationKind::DependsOnPrerequisiteChain => {
            replace_once(root, "build-dep/src/val.ts", "buildVal = 2", "buildVal = 9")?;
            out.rebuild_dep_for_oracle = true;
        }
        MutationKind::ShardedPlanUnionCompleteness => {
            replace_once(
                root,
                "core/math.ts",
                "n * baseScale()",
                "n * baseScale() + 8",
            )?;
            replace_once(root, "lang/hop-a.ts", "origVal = 2", "origVal = 8")?;
            out.sharded_plan_union = true;
        }
        MutationKind::MixedPassFailBatchIsolation => {
            replace_once(root, "lang/hop-a.ts", "origVal = 2", "origVal = 9")?;
            replace_once(
                root,
                "unrelated/control.test.ts",
                "1 + 1 !== 2",
                "2 + 2 !== 4",
            )?;
            out.verify_unrelated_passes = true;
        }
        _ => {}
    }
    Ok(out)
}

#[cfg(unix)]
fn create_file_symlink(target: &Path, link: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link)
        .map_err(|e| format!("symlink {} -> {}: {e}", link.display(), target.display()))
}

#[cfg(not(unix))]
fn create_file_symlink(target: &Path, link: &Path) -> Result<(), String> {
    fs::copy(target, link)
        .map(|_| ())
        .map_err(|e| e.to_string())
}
