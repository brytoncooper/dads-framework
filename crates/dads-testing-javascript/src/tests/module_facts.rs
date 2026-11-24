use crate::analyze_workspace;
use crate::facts::JsImportKind;
use std::fs::{create_dir_all, remove_dir_all, write};

#[test]
fn copies_static_typescript_facts_without_retaining_oxc_data() {
    let root = std::env::temp_dir().join("dads-testing-javascript-facts");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(root.join("src/leaf.ts"), "export const leaf = true;\n")
        .expect("fixture leaf must be written");
    write(
        root.join("src/importer.ts"),
        "import { leaf } from './leaf'; export { leaf };\n",
    )
    .expect("fixture importer must be written");
    let facts = analyze_workspace(&root);
    let importer = facts
        .modules
        .iter()
        .find(|module| module.path == "src/importer.ts")
        .expect("importer facts must exist");
    assert!(
        importer
            .declarations
            .iter()
            .any(|symbol| symbol.name == "leaf")
    );
    assert!(
        importer
            .references
            .iter()
            .any(|symbol| symbol.name == "leaf")
    );
    assert!(
        importer
            .imports
            .iter()
            .any(|import| import.kind == JsImportKind::StaticImport
                && import.resolved_path.as_deref() == Some("src/leaf.ts"))
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn resolves_a_local_js_specifier_to_an_existing_typescript_source_sibling() {
    let root = std::env::temp_dir().join("dads-testing-javascript-js-specifier-typescript-source");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(root.join("src/leaf.ts"), "export const leaf = true;\n")
        .expect("fixture TypeScript leaf must be written");
    write(
        root.join("src/importer.js"),
        "const leaf = require('./leaf.js'); module.exports = leaf;\n",
    )
    .expect("fixture JavaScript importer must be written");

    let facts = analyze_workspace(&root);
    let importer = facts
        .modules
        .iter()
        .find(|module| module.path == "src/importer.js")
        .expect("importer facts must exist");
    assert!(importer.imports.iter().any(|import| {
        import.kind == JsImportKind::CommonJsRequire
            && import.resolved_path.as_deref() == Some("src/leaf.ts")
    }));
    assert!(
        !facts
            .uncertainties
            .iter()
            .any(|uncertainty| uncertainty.code == "unresolved-local-module")
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn resolves_external_packages_that_require_import_conditions() {
    let root = std::env::temp_dir().join("dads-testing-javascript-package-exports");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    create_dir_all(root.join("node_modules/example-package"))
        .expect("fixture package directory must be created");
    write(
        root.join("node_modules/example-package/package.json"),
        r#"{"type":"module","exports":{".":{"import":{"default":"./index.js"}}}}"#,
    )
    .expect("fixture package manifest must be written");
    write(
        root.join("node_modules/example-package/index.js"),
        "export const externalValue = true;\n",
    )
    .expect("fixture package module must be written");
    write(
        root.join("src/importer.ts"),
        "import { externalValue } from 'example-package'; export { externalValue };\n",
    )
    .expect("fixture importer must be written");

    let facts = analyze_workspace(&root);

    assert!(
        !facts
            .uncertainties
            .iter()
            .any(|uncertainty| uncertainty.code == "unresolved-bare-module")
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn resolves_workspace_aliases_from_the_nearest_tsconfig() {
    let root = std::env::temp_dir().join("dads-testing-javascript-tsconfig-paths");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(
        root.join("tsconfig.json"),
        r#"{"compilerOptions":{"paths":{"@fixture/*":["./src/*"]}}}"#,
    )
    .expect("fixture tsconfig must be written");
    write(root.join("src/leaf.ts"), "export const value = true;\n")
        .expect("fixture leaf must be written");
    write(
        root.join("src/importer.ts"),
        "import { value } from '@fixture/leaf'; export { value };\n",
    )
    .expect("fixture importer must be written");

    let facts = analyze_workspace(&root);
    let importer = facts
        .modules
        .iter()
        .find(|module| module.path == "src/importer.ts")
        .expect("importer facts must exist");

    assert!(
        importer
            .imports
            .iter()
            .any(|import| import.resolved_path.as_deref() == Some("src/leaf.ts"))
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn keeps_runtime_symbols_from_a_mixed_runtime_and_type_import() {
    let root = std::env::temp_dir().join("dads-testing-javascript-mixed-import");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(
        root.join("src/leaf.ts"),
        "export const value = true; export type Value = boolean;\n",
    )
    .expect("fixture leaf must be written");
    write(
        root.join("src/importer.ts"),
        "import { value, type Value } from './leaf'; export const result: Value = value;\n",
    )
    .expect("fixture importer must be written");

    let facts = analyze_workspace(&root);
    let importer = facts
        .modules
        .iter()
        .find(|module| module.path == "src/importer.ts")
        .expect("importer facts must exist");
    let local_import = importer
        .imports
        .iter()
        .find(|import| import.resolved_path.as_deref() == Some("src/leaf.ts"))
        .expect("local import facts must exist");

    assert!(!local_import.type_only);
    assert_eq!(
        local_import.requested_symbols,
        ["value".to_owned()].into_iter().collect()
    );
    assert!(facts.uncertainties.is_empty());
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn preserves_workspace_relative_paths_after_oxc_resolves_a_real_local_file() {
    let root = std::env::temp_dir().join("dads-testing-javascript-canonical-local-resolution");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(root.join("src/leaf.js"), "module.exports = true;\n")
        .expect("fixture JavaScript leaf must be written");
    write(
        root.join("src/importer.js"),
        "const leaf = require('./leaf'); module.exports = leaf;\n",
    )
    .expect("fixture JavaScript importer must be written");

    let facts = analyze_workspace(&root);
    let importer = facts
        .modules
        .iter()
        .find(|module| module.path == "src/importer.js")
        .expect("importer facts must exist");
    assert!(importer.imports.iter().any(|import| {
        import.kind == JsImportKind::CommonJsRequire
            && import.resolved_path.as_deref() == Some("src/leaf.js")
    }));
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn marks_an_unresolved_bare_alias_as_uncertain() {
    let root = std::env::temp_dir().join("dads-testing-javascript-unresolved-bare-alias");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(
        root.join("src/importer.ts"),
        "import { value } from '@workspace/missing'; export { value };\n",
    )
    .expect("fixture importer must be written");

    let facts = analyze_workspace(&root);
    assert!(
        facts
            .uncertainties
            .iter()
            .any(|uncertainty| uncertainty.code == "unresolved-bare-module")
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn records_an_imported_local_reexport_at_its_export_statement_span() {
    let root = std::env::temp_dir().join("dads-testing-javascript-imported-local-reexport");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(root.join("src/leaf.ts"), "export const sourceValue = 1;\n")
        .expect("fixture source leaf must be written");
    let reexport =
        "import { sourceValue as imported } from './leaf';\nexport { imported as publicValue };\n";
    write(root.join("src/middle.ts"), reexport).expect("fixture re-export must be written");

    let facts = analyze_workspace(&root);
    let middle = facts
        .modules
        .iter()
        .find(|module| module.path == "src/middle.ts")
        .expect("re-export facts must exist");
    let declaration = middle
        .declarations
        .iter()
        .find(|declaration| declaration.name == "publicValue")
        .expect("explicit imported local re-export must have a declaration fact");
    assert!(
        reexport[declaration.span.start as usize..declaration.span.end as usize]
            .trim_start()
            .starts_with("export")
    );
    assert!(
        !facts
            .uncertainties
            .iter()
            .any(|uncertainty| uncertainty.code == "ambiguous-re-export")
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn destructured_static_dynamic_import_narrows_while_rest_and_bare_widen() {
    let root = std::env::temp_dir().join("dads-testing-javascript-dynamic-import-narrowing");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(
        root.join("src/target.ts"),
        "export const alpha = 1;\nexport const beta = 2;\n",
    )
    .expect("fixture target must be written");
    write(
        root.join("src/destructured.ts"),
        "export async function run() {\n  const { alpha, beta: b } = await import('./target');\n  return [alpha, b];\n}\n",
    )
    .expect("fixture destructured importer must be written");
    write(
        root.join("src/member-only.ts"),
        "export async function run() {\n  const mod = await import('./target');\n  return mod.alpha;\n}\n",
    )
    .expect("fixture member-only importer must be written");
    write(
        root.join("src/rest-spread.ts"),
        "export async function run() {\n  const { alpha, ...rest } = await import('./target');\n  return { alpha, rest };\n}\n",
    )
    .expect("fixture rest-spread importer must be written");
    write(
        root.join("src/side-effect.ts"),
        "export async function run() {\n  await import('./target');\n}\n",
    )
    .expect("fixture side-effect importer must be written");

    let facts = analyze_workspace(&root);
    let requested_for = |path: &str| {
        facts
            .modules
            .iter()
            .find(|module| module.path == path)
            .expect("module must exist")
            .imports
            .iter()
            .find(|import| import.kind == JsImportKind::DynamicImport)
            .expect("dynamic import must exist")
            .requested_symbols
            .clone()
    };

    assert_eq!(
        requested_for("src/destructured.ts"),
        std::collections::BTreeSet::from(["alpha".to_owned(), "beta".to_owned()])
    );
    assert_eq!(
        requested_for("src/member-only.ts"),
        std::collections::BTreeSet::from(["alpha".to_owned()])
    );
    assert!(requested_for("src/rest-spread.ts").is_empty());
    assert!(requested_for("src/side-effect.ts").is_empty());
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn skips_gitignored_build_outputs_and_nested_worktrees_while_indexing_unignored_files() {
    let root = std::env::temp_dir().join("dads-testing-javascript-respects-gitignore");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("src dir must be created");
    create_dir_all(root.join("infrastructure/cdk.out")).expect("cdk.out dir must be created");
    create_dir_all(root.join(".claude/worktrees/agent-a/src"))
        .expect("worktree dir must be created");

    write(
        root.join(".gitignore"),
        "infrastructure/cdk.out/\n.claude/\n",
    )
    .expect(".gitignore must be written");
    write(root.join("src/tracked.ts"), "export const tracked = 1;\n")
        .expect("tracked file must be written");
    write(
        root.join("infrastructure/cdk.out/bundle.js"),
        "export const x = (p) => import(p);\n",
    )
    .expect("gitignored cdk bundle must be written");
    write(
        root.join(".claude/worktrees/agent-a/src/broken.ts"),
        "export const broken = (((\n",
    )
    .expect("gitignored worktree file must be written");

    let run_git = |args: &[&str]| {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(&root)
            .status()
            .expect("git must start");
        assert!(status.success(), "git {:?} must succeed", args);
    };
    run_git(&["init", "-q"]);
    run_git(&["config", "user.email", "test@example.invalid"]);
    run_git(&["config", "user.name", "Dads Test"]);
    run_git(&["add", "."]);
    run_git(&["commit", "-qm", "baseline"]);

    // Add a new unignored untracked source file after baseline commit.
    write(
        root.join("src/untracked.ts"),
        "export const untracked = 2;\n",
    )
    .expect("untracked file must be written");

    let facts = analyze_workspace(&root);
    let paths: std::collections::BTreeSet<String> =
        facts.modules.iter().map(|m| m.path.clone()).collect();
    assert_eq!(
        paths,
        std::collections::BTreeSet::from([
            "src/tracked.ts".to_owned(),
            "src/untracked.ts".to_owned(),
        ])
    );
    assert!(
        facts.uncertainties.is_empty(),
        "gitignored dynamic imports and broken files must not produce uncertainties: {:?}",
        facts.uncertainties
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn ignores_method_declarations_member_calls_and_comments_named_require() {
    let root = std::env::temp_dir().join("dads-testing-javascript-require-false-positives");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(
        root.join("src/service.ts"),
        r#"
// require(commentedPath)
const label = "require(inString)";
export class Guard {
  async require(permission: string): Promise<boolean> {
    return permission.length > 0;
  }
  async check(permission: string): Promise<boolean> {
    return this.require(permission);
  }
}
export function helper(obj: { require: (x: string) => void }, x: string) {
  obj.require(x);
}
export { label };
"#,
    )
    .expect("fixture service must be written");
    write(
        root.join("src/dynamic.cjs"),
        "module.exports = (target) => require(target);\n",
    )
    .expect("fixture dynamic require must be written");

    let facts = analyze_workspace(&root);
    let nonliteral_paths: Vec<&str> = facts
        .uncertainties
        .iter()
        .filter(|u| u.code == "nonliteral-commonjs-require")
        .map(|u| u.path.as_str())
        .collect();
    assert_eq!(nonliteral_paths, vec!["src/dynamic.cjs"]);
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn resolves_local_mjs_and_cjs_specifiers_to_typescript_mts_and_cts_siblings() {
    let root = std::env::temp_dir().join("dads-testing-javascript-mts-cts-siblings");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(root.join("src/esm-leaf.mts"), "export const esm = 1;\n")
        .expect("fixture mts leaf must be written");
    write(root.join("src/cjs-leaf.cts"), "export const cjs = 2;\n")
        .expect("fixture cts leaf must be written");
    write(
        root.join("src/importer.mts"),
        "import { esm } from './esm-leaf.mjs';\nimport { cjs } from './cjs-leaf.cjs';\nexport const sum = esm + cjs;\n",
    )
    .expect("fixture importer must be written");

    let facts = analyze_workspace(&root);
    let importer = facts
        .modules
        .iter()
        .find(|module| module.path == "src/importer.mts")
        .expect("importer facts must exist");
    let resolved: std::collections::BTreeSet<&str> = importer
        .imports
        .iter()
        .filter_map(|import| import.resolved_path.as_deref())
        .collect();
    assert_eq!(
        resolved,
        std::collections::BTreeSet::from(["src/esm-leaf.mts", "src/cjs-leaf.cts"])
    );
    assert!(
        facts.uncertainties.is_empty(),
        "mts/cts sibling imports must not emit uncertainties: {:?}",
        facts.uncertainties
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn resolves_bare_type_subpath_from_at_types_package() {
    let root = std::env::temp_dir().join("dads-testing-javascript-at-types-subpath");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    create_dir_all(root.join("node_modules/@types/example-doc"))
        .expect("fixture @types package directory must be created");
    write(
        root.join("node_modules/@types/example-doc/package.json"),
        r#"{"name":"@types/example-doc","version":"1.0.0"}"#,
    )
    .expect("fixture @types package manifest must be written");
    write(
        root.join("node_modules/@types/example-doc/interfaces.d.ts"),
        "export interface DocDefinition { title: string; }\n",
    )
    .expect("fixture @types declaration must be written");
    write(
        root.join("src/consumer.ts"),
        "import type { DocDefinition } from 'example-doc/interfaces';\nexport const make = (d: DocDefinition) => d.title;\n",
    )
    .expect("fixture consumer must be written");

    let facts = analyze_workspace(&root);
    assert!(
        !facts
            .uncertainties
            .iter()
            .any(|uncertainty| uncertainty.code == "unresolved-bare-module"),
        "@types subpath should resolve without unresolved-bare-module: {:?}",
        facts.uncertainties
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}
