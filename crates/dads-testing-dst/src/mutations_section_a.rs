//! Mutations for the 10 Section A (Phase 1) DST families (#59-#68).

use crate::model::MutationKind;
use crate::mutations::{AppliedMutation, replace_once};
use std::fs;
use std::path::Path;

pub fn is_section_a_mutation(kind: MutationKind) -> bool {
    matches!(
        kind,
        MutationKind::ObjectFreezeSharedIdent
            | MutationKind::ImplicitCoercionSideEffect
            | MutationKind::TopLevelLoadThrowPureTrap
            | MutationKind::ExistsSyncMissingAtBaseline
            | MutationKind::ReaddirSyncEmptyOrOvercapDir
            | MutationKind::CrossFileFsHelperAndUnresolved
            | MutationKind::ExtendedFsAndExecReadApis
            | MutationKind::GitignoredImpactPathsGlob
            | MutationKind::UpstreamPackageExportsAndNestedTsconfig
            | MutationKind::NonRootAndDotenvConfigFiles
    )
}

pub fn apply_section_a_mutation(
    root: &Path,
    kind: MutationKind,
    step_idx: usize,
) -> Result<AppliedMutation, String> {
    let mut applied = AppliedMutation::default();
    match kind {
        MutationKind::ObjectFreezeSharedIdent => {
            replace_once(
                root,
                "lang/freeze-shared.ts",
                "Object.freeze({ ok: 1 })",
                "Object.freeze(sharedCfg)",
            )?;
        }
        MutationKind::ImplicitCoercionSideEffect => {
            replace_once(
                root,
                "lang/coercion.ts",
                "export const tag = `${\"safe\"}`;",
                "export const tag = `${box}`;",
            )?;
        }
        MutationKind::TopLevelLoadThrowPureTrap => match step_idx % 3 {
            0 => replace_once(
                root,
                "lang/load-throw.ts",
                "new RegExp(\"^[a-z]+$\", \"i\")",
                "new RegExp(\"[unclosed\", \"i\")",
            )?,
            1 => replace_once(
                root,
                "lang/load-throw.ts",
                "export const pat = new RegExp(\"^[a-z]+$\", \"i\");",
                "export const pat = 1n / 0n;",
            )?,
            _ => replace_once(
                root,
                "lang/load-throw.ts",
                "export const pat = new RegExp(\"^[a-z]+$\", \"i\");",
                "export const pat = tdzLater;\nconst tdzLater = 1;",
            )?,
        },
        MutationKind::ExistsSyncMissingAtBaseline => {
            fs::write(
                root.join("settings/sentinel-missing.json"),
                "{\"bad\":true}\n",
            )
            .map_err(|e| format!("write sentinel-missing.json: {e}"))?;
        }
        MutationKind::ReaddirSyncEmptyOrOvercapDir => {
            fs::create_dir_all(root.join("settings/empty-scan"))
                .map_err(|e| format!("mkdir empty-scan: {e}"))?;
            fs::write(root.join("settings/empty-scan/first.json"), "{}\n")
                .map_err(|e| format!("write empty-scan/first.json: {e}"))?;
        }
        MutationKind::CrossFileFsHelperAndUnresolved => {
            if step_idx.is_multiple_of(2) {
                replace_once(
                    root,
                    "settings/dyn-fixtures/item.json",
                    "\"factor\":2",
                    "\"factor\":9",
                )?;
            } else {
                replace_once(
                    root,
                    "settings/dyn-secret.json",
                    "\"secret\":2",
                    "\"secret\":9",
                )?;
            }
        }
        MutationKind::ExtendedFsAndExecReadApis => {
            if step_idx.is_multiple_of(2) {
                replace_once(root, "settings/access-target.json", "\"v\":2", "\"v\":9")?;
            } else {
                replace_once(root, "settings/check-script.mjs", "\"2\"", "\"9\"")?;
            }
        }
        MutationKind::GitignoredImpactPathsGlob => {
            fs::write(
                root.join("settings/generated-ignored/schema.json"),
                "{\"ok\":false}\n",
            )
            .map_err(|e| format!("write generated-ignored/schema.json: {e}"))?;
            applied.force_only_tasks = vec!["impact-consumer:test".to_owned()];
        }
        MutationKind::UpstreamPackageExportsAndNestedTsconfig => {
            replace_once(
                root,
                "lang-pkg/package.json",
                "\".\": \"./a.ts\"",
                "\".\": \"./b.ts\"",
            )?;
        }
        MutationKind::NonRootAndDotenvConfigFiles => {
            fs::write(root.join(".env.test"), "TEST_MULT=9\n")
                .map_err(|e| format!("write .env.test: {e}"))?;
            applied.force_only_tasks = vec!["adv:test".to_owned()];
        }
        _ => return Err(format!("not a section A mutation: {kind:?}")),
    }
    Ok(applied)
}
