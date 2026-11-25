//! Section C (#79-#85) mutations: default re-export gymnastics, class/member decorators,
//! tagged templates, TS namespaces + declaration merging + `const enum`, `new CustomClass()` +
//! impure `Map`, `pureFactories` precision & impure-arg trap, and diamond `export *` shadowing.

use crate::model::{MutationKind, WorkspaceShape};
use crate::mutations::{AppliedMutation, replace_once};
use std::path::Path;

pub fn apply_section_c_mutation(
    root: &Path,
    shape: &WorkspaceShape,
    kind: MutationKind,
    step_idx: usize,
) -> Result<AppliedMutation, String> {
    let variant = (shape.seed as usize).wrapping_add(step_idx);
    let mut applied = AppliedMutation::default();
    match kind {
        MutationKind::DefaultReexportGymnastics => {
            replace_once(root, "lang/def-hop-a.ts", "return n * 2;", "return n * 5;")?;
        }
        MutationKind::ClassAndMemberDecoratorsSideEffect => {
            if variant.is_multiple_of(2) {
                replace_once(
                    root,
                    "lang/decorators.ts",
                    "@recordDec(\"cls\", 2)",
                    "@recordDec(\"cls\", 9)",
                )?;
            } else {
                replace_once(
                    root,
                    "lang/decorators.ts",
                    "@recordDec(\"fld\", 2)",
                    "@recordDec(\"fld\", 9)",
                )?;
            }
        }
        MutationKind::TaggedTemplateLiteralSideEffect => {
            replace_once(
                root,
                "lang/tagged-tpl.ts",
                "tag`size:${2}`",
                "tag`size:${9}`",
            )?;
        }
        MutationKind::TsNamespaceDeclarationMergingConstEnum => match variant % 3 {
            0 => replace_once(
                root,
                "lang/ns-merge.ts",
                "export const factor = 2;",
                "export const factor = 9;",
            )?,
            1 => replace_once(
                root,
                "lang/ns-merge.ts",
                "export const mult = 2;",
                "export const mult = 9;",
            )?,
            _ => replace_once(root, "lang/ns-merge.ts", "Base = 2,", "Base = 9,")?,
        },
        MutationKind::NewCustomClassAndPureBuiltinEdge => {
            if variant.is_multiple_of(2) {
                replace_once(
                    root,
                    "lang/new-and-map.ts",
                    "new SideEffectBox(2)",
                    "new SideEffectBox(9)",
                )?;
            } else {
                replace_once(root, "lang/new-and-map.ts", "bumpMap(2)", "bumpMap(9)")?;
            }
        }
        MutationKind::PureFactoriesPrecisionAndImpureArg => {
            if variant.is_multiple_of(2) {
                replace_once(root, "lang/pure-factory-trap.ts", "bumpPf(2)", "bumpPf(9)")?;
            } else {
                replace_once(
                    root,
                    "lang/pure-factory-clean.ts",
                    "z.object({ a: 1 })",
                    "z.object({ a: 99 })",
                )?;
                applied.expected_skipped_tasks.push("adv:test".to_owned());
            }
        }
        MutationKind::DiamondExportStarShadowing => match variant % 3 {
            0 => replace_once(
                root,
                "lang/diamond-mid.ts",
                "export const shared = 10;",
                "export const shared = 99;",
            )?,
            1 => replace_once(
                root,
                "lang/diamond-leaf.ts",
                "export const leafOnly = 3;",
                "export const leafOnly = 99;",
            )?,
            _ => replace_once(
                root,
                "lang/diamond-leaf.ts",
                "export const shared = 2;",
                "export const shared = 99;",
            )?,
        },
        _ => return Err(format!("not a section C mutation: {kind:?}")),
    }
    Ok(applied)
}
