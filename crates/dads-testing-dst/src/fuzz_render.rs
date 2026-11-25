//! TypeScript leaf module, barrel chain, and `.test.ts` source renderer for chaos workspaces.

use crate::fuzz_graph::{
    ChaosBarrelStyle, ChaosLeafData, ChaosModuleKind, ChaosModuleSpec, ChaosProjectSpec,
    ChaosWorkspaceSpec, ExportShape, relative_import_path,
};
use std::fmt::Write as _;

pub fn render_module(spec: &ChaosWorkspaceSpec, module: &ChaosModuleSpec) -> String {
    match &module.kind {
        ChaosModuleKind::Leaf(leaf) => render_leaf_module(spec, module, leaf),
        ChaosModuleKind::Barrel {
            style,
            target_mod,
            use_alias,
        } => render_barrel_module(spec, module, *style, *target_mod, *use_alias),
    }
}

fn render_leaf_module(
    spec: &ChaosWorkspaceSpec,
    module: &ChaosModuleSpec,
    leaf: &ChaosLeafData,
) -> String {
    let mut out = String::from("// @comment: 0\n");
    if leaf.fixture_idx.is_some() {
        out.push_str("import { readFileSync } from \"node:fs\";\n");
    }
    let rt_spec = relative_import_path(&module.rel_path, "chaos-rt/rt.ts");
    let _ = writeln!(out, "import {{ mkPure, z, bumpChaos }} from \"{rt_spec}\";");
    for (idx, edge) in leaf.imports.iter().enumerate() {
        let target = &spec.modules[edge.target_mod];
        let import_spec = specifier_for(spec, &module.rel_path, target, edge.use_alias);
        let _ = writeln!(
            out,
            "import type {{ ModTag as T_{idx} }} from \"{import_spec}\";"
        );
        if !edge.type_only {
            emit_runtime_import(&mut out, target.export_shape, idx, &import_spec);
        }
    }
    for &se_target in &leaf.side_effect_imports {
        let target = &spec.modules[se_target];
        let import_spec = relative_import_path(&module.rel_path, &target.rel_path);
        let _ = writeln!(out, "import \"{import_spec}\"; // @se-{se_target}");
    }
    out.push_str("// @se-insert\n// @added-import\n");
    let _ = writeln!(
        out,
        "const helperVal = (): number => {}; // @helper",
        leaf.helper_val
    );
    out.push_str("export type ModTag = number; // @type\n");
    out.push_str("export interface ModInfo { val: number; tag: ModTag; }\n");
    out.push_str("// @adj-comment: 0\n");
    let _ = writeln!(
        out,
        "export const pureVal: number = {}; // @pure",
        leaf.pure_val
    );
    let _ = writeln!(
        out,
        "export const unusedPure: number = {}; // @unused-pure",
        leaf.unused_pure_val
    );
    let ann_rhs = if leaf.has_pure_annotation {
        format!("/*#__PURE__*/ mkPure({})", leaf.pure_val)
    } else {
        leaf.pure_val.to_string()
    };
    let _ = writeln!(
        out,
        "export const pureAnn: number = {ann_rhs}; // @pure-ann"
    );
    let fac_rhs = if leaf.has_pure_factory {
        format!("z.num({})", leaf.pure_val)
    } else {
        leaf.pure_val.to_string()
    };
    let _ = writeln!(out, "export const facVal: number = {fac_rhs}; // @pure-fac");
    let imp_rhs = if leaf.has_impure_init {
        format!("bumpChaos({}, {})", module.id, leaf.impure_val)
    } else {
        leaf.impure_val.to_string()
    };
    let _ = writeln!(
        out,
        "export const impureInit: number = {imp_rhs}; // @impure"
    );
    append_leaf_compute_body(&mut out, spec, module, leaf);
    out
}

fn append_leaf_compute_body(
    out: &mut String,
    spec: &ChaosWorkspaceSpec,
    module: &ChaosModuleSpec,
    leaf: &ChaosLeafData,
) {
    for idx in 0..leaf.imports.len() {
        let _ = writeln!(
            out,
            "const _tc_{idx}: T_{idx} = 0; const _tcc_{idx}: number = _tc_{idx}; void _tcc_{idx};"
        );
    }
    out.push_str("export function compute(depth = 0): number {\n");
    out.push_str("  let acc = pureVal + helperVal() + pureAnn + facVal + impureInit;\n");
    out.push_str("  acc += 0; // @added-use\n");
    if let Some(fx_idx) = leaf.fixture_idx {
        let fx_rel = relative_import_path(&module.rel_path, &spec.fixtures[fx_idx].rel_path);
        let _ = writeln!(
            out,
            "  const fx = JSON.parse(readFileSync(new URL(\"{fx_rel}\", import.meta.url), \"utf8\")) as {{ value: number }};"
        );
        out.push_str("  acc = (acc * 31 + fx.value) | 0;\n");
    }
    out.push_str("  if (depth < 2) {\n");
    for (idx, edge) in leaf.imports.iter().enumerate() {
        if !edge.type_only {
            let call = call_expr(spec.modules[edge.target_mod].export_shape, idx, "depth + 1");
            let _ = writeln!(out, "    acc = (acc * 31 + {call}) | 0;");
        }
    }
    out.push_str("  }\n  return acc;\n}\nexport default compute;\n");
}

fn render_barrel_module(
    spec: &ChaosWorkspaceSpec,
    module: &ChaosModuleSpec,
    style: ChaosBarrelStyle,
    target_mod: usize,
    use_alias: bool,
) -> String {
    let target = &spec.modules[target_mod];
    let s = specifier_for(spec, &module.rel_path, target, use_alias);
    let mut out = String::from("// @comment: 0\n");
    match (style, target.export_shape) {
        (ChaosBarrelStyle::Named, ExportShape::Standard) => {
            let _ = writeln!(out, "export {{ compute, unusedPure }} from \"{s}\";");
            let _ = writeln!(out, "export {{ default }} from \"{s}\";");
            let _ = writeln!(out, "export type {{ ModTag }} from \"{s}\";");
        }
        (ChaosBarrelStyle::Named, ExportShape::Aliased) => {
            let _ = writeln!(out, "export {{ aliasedCompute as compute }} from \"{s}\";");
            let _ = writeln!(out, "export {{ aliasedCompute as default }} from \"{s}\";");
            let _ = writeln!(out, "export type {{ ModTag }} from \"{s}\";");
        }
        (ChaosBarrelStyle::Named, ExportShape::DefaultOnly) => {
            let _ = writeln!(
                out,
                "export {{ default as compute, default }} from \"{s}\";"
            );
            let _ = writeln!(out, "export type {{ ModTag }} from \"{s}\";");
        }
        (ChaosBarrelStyle::Named, ExportShape::Namespace) => {
            let _ = writeln!(out, "export {{ ns }} from \"{s}\";");
            let _ = writeln!(out, "export type {{ ModTag }} from \"{s}\";");
        }
        (ChaosBarrelStyle::Aliased, _) => {
            let _ = writeln!(
                out,
                "export {{ compute as aliasedCompute, unusedPure }} from \"{s}\";"
            );
            let _ = writeln!(out, "export type {{ ModTag }} from \"{s}\";");
        }
        (ChaosBarrelStyle::DefaultWrap, _) => {
            let _ = writeln!(out, "export {{ default }} from \"{s}\";");
            let _ = writeln!(out, "export type {{ ModTag }} from \"{s}\";");
        }
        (ChaosBarrelStyle::ExportStar, shape) => {
            let _ = writeln!(out, "export * from \"{s}\";");
            if matches!(shape, ExportShape::Standard | ExportShape::DefaultOnly) {
                let _ = writeln!(out, "export {{ default }} from \"{s}\";");
            }
        }
        (ChaosBarrelStyle::ExportStarAsNs, _) => {
            let _ = writeln!(out, "export * as ns from \"{s}\";");
            let _ = writeln!(out, "export type {{ ModTag }} from \"{s}\";");
        }
    }
    out
}

pub fn render_suite_test(
    spec: &ChaosWorkspaceSpec,
    proj: &ChaosProjectSpec,
    proj_idx: usize,
    suite_rel: &str,
    proj_mods: &[usize],
) -> String {
    let mut out = String::new();
    let rt_spec = relative_import_path(suite_rel, "chaos-rt/rt.ts");
    let _ = writeln!(out, "import {{ readChaosReg }} from \"{rt_spec}\";");
    let mut observed: Vec<usize> = proj_mods.to_vec();
    for &extra_id in &proj.extra_test_imports {
        if !observed.contains(&extra_id) {
            observed.push(extra_id);
        }
    }
    for (idx, &mod_id) in observed.iter().enumerate() {
        let target = &spec.modules[mod_id];
        let use_alias = spec.use_tsconfig_aliases && target.project_idx != proj_idx;
        let import_spec = specifier_for(spec, suite_rel, target, use_alias);
        let _ = writeln!(
            out,
            "import type {{ ModTag as T_{idx} }} from \"{import_spec}\";"
        );
        emit_runtime_import(&mut out, target.export_shape, idx, &import_spec);
    }
    for idx in 0..observed.len() {
        let _ = writeln!(
            out,
            "const _tc_{idx}: T_{idx} = 0; const _tcc_{idx}: number = _tc_{idx}; void _tcc_{idx};"
        );
    }
    out.push_str("let h = 19;\n");
    for (idx, &mod_id) in observed.iter().enumerate() {
        let call = call_expr(spec.modules[mod_id].export_shape, idx, "0");
        let _ = writeln!(out, "h = (h * 31 + {call}) | 0;");
    }
    out.push_str("h = (h * 31 + readChaosReg()) | 0;\n");
    out.push_str("h = (h * 31 + Number(process.env.CHAOS_ENV ?? \"0\")) | 0;\n");
    out.push_str("const EXPECTED = 0; // @expected\n");
    out.push_str("if (process.env.CHAOS_RECORD_BASELINE === \"1\") { throw new Error(`__CHAOS_BASELINE__:${h}`); }\n");
    let _ = writeln!(
        out,
        "if (h !== EXPECTED) {{ throw new Error(`chaos mismatch in {}: got ${{h}} expected ${{EXPECTED}}`); }}",
        proj.id
    );
    out
}

pub fn render_extra_test(spec: &ChaosWorkspaceSpec, extra_rel: &str, mod_id: usize) -> String {
    let target = &spec.modules[mod_id];
    let import_spec = relative_import_path(extra_rel, &target.rel_path);
    let mut out = String::new();
    emit_runtime_import(&mut out, target.export_shape, 0, &import_spec);
    let call = call_expr(target.export_shape, 0, "0");
    let _ = writeln!(out, "const h = {call} | 0;");
    out.push_str("const EXPECTED = 0; // @expected\n");
    out.push_str("if (process.env.CHAOS_RECORD_BASELINE === \"1\") { throw new Error(`__CHAOS_BASELINE__:${h}`); }\n");
    out.push_str("if (h !== EXPECTED) { throw new Error(`chaos extra mismatch: got ${h} expected ${EXPECTED}`); }\n");
    out
}

fn specifier_for(
    spec: &ChaosWorkspaceSpec,
    from_file: &str,
    target: &ChaosModuleSpec,
    use_alias: bool,
) -> String {
    if use_alias && spec.use_tsconfig_aliases {
        let proj_id = &spec.projects[target.project_idx].id;
        format!("@{proj_id}/m{}.ts", target.id)
    } else {
        relative_import_path(from_file, &target.rel_path)
    }
}

fn emit_runtime_import(out: &mut String, shape: ExportShape, idx: usize, spec: &str) {
    match shape {
        ExportShape::Standard => {
            let _ = writeln!(out, "import {{ compute as c_{idx} }} from \"{spec}\";");
        }
        ExportShape::Aliased => {
            let _ = writeln!(
                out,
                "import {{ aliasedCompute as c_{idx} }} from \"{spec}\";"
            );
        }
        ExportShape::DefaultOnly => {
            let _ = writeln!(out, "import c_{idx} from \"{spec}\";");
        }
        ExportShape::Namespace => {
            let _ = writeln!(out, "import {{ ns as ns_{idx} }} from \"{spec}\";");
        }
    }
}

fn call_expr(shape: ExportShape, idx: usize, depth_arg: &str) -> String {
    match shape {
        ExportShape::Namespace => format!("ns_{idx}.compute({depth_arg})"),
        _ => format!("c_{idx}({depth_arg})"),
    }
}
