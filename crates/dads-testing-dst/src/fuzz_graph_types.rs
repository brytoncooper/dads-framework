//! Serializable data model for generated random-graph chaos workspaces (`ChaosWorkspaceSpec`).

use crate::model::FallbackMode;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChaosBarrelStyle {
    Named,
    Aliased,
    DefaultWrap,
    ExportStar,
    ExportStarAsNs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExportShape {
    Standard,
    Aliased,
    DefaultOnly,
    Namespace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChaosImportEdge {
    pub target_mod: usize,
    pub use_alias: bool,
    pub type_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChaosLeafData {
    pub pure_val: i32,
    pub unused_pure_val: i32,
    pub helper_val: i32,
    pub impure_val: i32,
    pub has_impure_init: bool,
    pub has_pure_annotation: bool,
    pub has_pure_factory: bool,
    pub fixture_idx: Option<usize>,
    pub imports: Vec<ChaosImportEdge>,
    pub side_effect_imports: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ChaosModuleKind {
    Leaf(ChaosLeafData),
    Barrel {
        style: ChaosBarrelStyle,
        target_mod: usize,
        use_alias: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChaosModuleSpec {
    pub id: usize,
    pub project_idx: usize,
    pub rel_path: String,
    pub kind: ChaosModuleKind,
    pub export_shape: ExportShape,
    pub barrel_depth: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChaosProjectSpec {
    pub id: String,
    pub root: String,
    pub fallback_mode: FallbackMode,
    pub fallback_deps: Vec<String>,
    pub env_tag: String,
    pub has_typecheck: bool,
    pub extra_test_imports: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChaosFixtureSpec {
    pub rel_path: String,
    pub value: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChaosWorkspaceSpec {
    pub seed: u64,
    pub projects: Vec<ChaosProjectSpec>,
    pub modules: Vec<ChaosModuleSpec>,
    pub fixtures: Vec<ChaosFixtureSpec>,
    pub use_file_narrowing: bool,
    pub use_tsconfig_aliases: bool,
    pub pure_factories: Vec<String>,
}
