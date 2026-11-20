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
