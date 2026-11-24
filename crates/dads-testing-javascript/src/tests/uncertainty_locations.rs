use super::fixtures::located_uncertainty;
use crate::JavaScriptFrontend;
use crate::analyze_workspace;
use crate::facts::JsPosition;
use crate::graph_export::copy_to_core_graph;
use dads_testing_core::graph::{ChangedModuleEvidence, GraphUncertaintyScope};
use dads_testing_store::GraphFrontend;
use std::fs::{create_dir_all, remove_dir_all, write};

#[test]
fn nonliteral_dynamic_import_is_a_whole_workspace_uncertainty() {
    let root = std::env::temp_dir().join("dads-testing-javascript-unbounded-dynamic-import");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(
        root.join("src/changed.ts"),
        "export const changed = true;\n",
    )
    .expect("changed source must be written");
    write(
        root.join("src/dynamic.ts"),
        "export async function load(path: string) { return import(path); }\n",
    )
    .expect("dynamic source must be written");

    let graph = copy_to_core_graph(analyze_workspace(&root)).with_changed_module_evidence(vec![
        ChangedModuleEvidence {
            path: "src/changed.ts".to_owned(),
            changed_exports: ["changed".to_owned()].into_iter().collect(),
            every_hunk_is_attributed: true,
            semantic_change: true,
            type_only_change: false,
        },
    ]);
    let reachable = graph.symbol_reachability_from(["src/changed.ts".to_owned()]);

    assert!(reachable.uncertainties.iter().any(|uncertainty| {
        uncertainty.path == "src/dynamic.ts"
            && uncertainty.code == "nonliteral-dynamic-import"
            && uncertainty.scope == GraphUncertaintyScope::WholeWorkspace
    }));
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn nonliteral_dynamic_import_uncertainty_has_line_and_column() {
    let root = std::env::temp_dir().join("dads-testing-javascript-located-dynamic-import");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(
        root.join("src/loader.ts"),
        "export const eager = 1;\nexport async function load(name: string) {\n  return import(name);\n}\n",
    )
    .expect("fixture loader must be written");

    let uncertainty = located_uncertainty(&root, "nonliteral-dynamic-import");

    assert_eq!(uncertainty.path, "src/loader.ts");
    assert_eq!(
        uncertainty.position,
        Some(JsPosition {
            line: 3,
            column: 17
        })
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn unresolved_local_import_uncertainty_points_at_its_specifier() {
    let root = std::env::temp_dir().join("dads-testing-javascript-located-unresolved-local");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(
        root.join("src/importer.ts"),
        "// leading comment\nimport { missing } from './missing.js';\nexport const value = missing;\n",
    )
    .expect("fixture importer must be written");

    let uncertainty = located_uncertainty(&root, "unresolved-local-module");

    assert_eq!(
        uncertainty.position,
        Some(JsPosition {
            line: 2,
            column: 25
        })
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn nonliteral_commonjs_require_has_a_location() {
    let root = std::env::temp_dir().join("dads-testing-javascript-located-commonjs-require");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(
        root.join("src/dynamic.cjs"),
        "const target = 'runtime';\nmodule.exports = require(`./${target}.cjs`);\n",
    )
    .expect("fixture CommonJS importer must be written");

    let uncertainty = located_uncertainty(&root, "nonliteral-commonjs-require");

    assert_eq!(
        uncertainty.position,
        Some(JsPosition {
            line: 2,
            column: 26
        })
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn parse_failure_uses_the_first_diagnostic_label() {
    let root = std::env::temp_dir().join("dads-testing-javascript-located-parse-failure");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(
        root.join("src/broken.ts"),
        "export const first = 1;\nexport const second = 2;\nconst broken = ;\n",
    )
    .expect("fixture broken source must be written");

    let uncertainty = located_uncertainty(&root, "javascript-parse-failed");

    assert_eq!(
        uncertainty.position.map(|position| position.line),
        Some(3),
        "the first diagnostic label must locate the failure: {uncertainty:?}"
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn file_level_uncertainties_have_no_location() {
    let root = std::env::temp_dir().join("dads-testing-javascript-unlocated-file-failure");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    std::fs::write(root.join("src/binary.ts"), [0x66, 0xff, 0xfe, 0x0a])
        .expect("fixture unreadable source must be written");

    let facts = analyze_workspace(&root);
    let uncertainty = facts
        .uncertainties
        .iter()
        .find(|uncertainty| uncertainty.code == "javascript-source-read-failed")
        .expect("an unreadable source must stay uncertain");

    assert_eq!(uncertainty.span, None);
    assert_eq!(uncertainty.position, None);
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn located_facts_declare_their_own_frontend_version() {
    assert_eq!(JavaScriptFrontend.frontend_version(), 13);
}
