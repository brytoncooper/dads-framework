export {
  asPermissionTerm,
  both,
  excluding,
  gated,
  through,
} from "./core/combinators.js";
export type { PermissionTermInput } from "./core/combinators.js";
export {
  checkAccessConformance,
  missingGrantingAdvisories,
} from "./core/conformance.js";
export type {
  ConformanceFailure,
  MissingGrantingAdvisory,
} from "./core/conformance.js";
export {
  accessIrDefinitionsDiff,
  accessIrDiff,
} from "./core/compare-access-ir.js";
export { catalogOnly, isCatalogOnlyCapability } from "./core/catalog-only.js";
export type { CatalogOnlyCapability } from "./core/catalog-only.js";
export { emitAccessIr } from "./core/emit-ir.js";
export { emitZed, emitZedForDefinitions } from "./core/emit-zed.js";
export { entityHandle } from "./core/entity-handle.js";
export type { EntityHandle, EntityKind } from "./core/entity-handle.js";
export {
  entitiesWithoutKind,
  entityKindOf,
  isSparseDirectGrant,
} from "./core/entity-kinds.js";
export {
  allowVisibleOnRecordUntil,
  expiredVisibleRecordExceptions,
  visibleRecordException,
} from "./core/visible-record-exceptions.js";
export type { VisibleRecordException } from "./core/visible-record-exceptions.js";
export { scopeBindings } from "./core/scope-bindings.js";
export type {
  RoleBinding,
  ScopeBindings,
  ScopeRoleBindings,
} from "./core/scope-bindings.js";
export {
  compileScopePlan,
  compileScopePlanInSchema,
  describeScopePlan,
  distinctScopeLookups,
  planScope,
  scopeSchema,
} from "./core/scope-plan.js";
export type {
  ScopeLookupPlan,
  ScopeLookupTarget,
  ScopePlan,
  ScopePlanFailure,
  ScopeSchema,
  ScopeViaPlan,
} from "./core/scope-plan.js";
export {
  checkScopeBindings,
  checkScopeBindingsInSchema,
} from "./core/scope-binding-check.js";
export {
  GENERATED_ZED_HEADER,
  isGeneratedByAccessKit,
} from "./core/generated-header.js";
export { grantable, isGrantableRole } from "./core/grantable.js";
export type {
  GrantableGroup,
  GrantableLocalizedText,
  GrantableRisk,
  GrantableRole,
  GrantableScope,
  GrantableTargetKind,
} from "./core/grantable.js";
export { membersOf, wildcard } from "./core/holders.js";
export type {
  RoleValue,
  SingleRoleValue,
  UsersetHolder,
  WildcardHolder,
} from "./core/holders.js";
export type {
  AccessIrDefinition,
  AccessIrPermission,
  AccessIrRole,
  AccessIrSubject,
  AccessIrTerm,
} from "./core/ir.js";
export { lifecycleTrigger } from "./core/lifecycle.js";
export type { LifecycleTrigger } from "./core/lifecycle.js";
export { access } from "./core/model.js";
export type {
  AccessDefinition,
  AccessGranting,
  PermissionTokens,
  RoleTokens,
} from "./core/model.js";
export { parseZed } from "./core/parse-zed.js";
export {
  isPermissionToken,
  isRoleToken,
  permissionToken,
  roleToken,
} from "./core/refs.js";
export type {
  BothTerm,
  ExcludingTerm,
  GatedTerm,
  OrTerm,
  PermissionTerm,
  PermissionToken,
  RoleHolder,
  RoleToken,
  ThroughTerm,
} from "./core/refs.js";
export { accessModel } from "./core/access-model.js";
export type {
  AccessModel,
  ResolvedAccessDefinition,
  ResolvedGranting,
} from "./core/access-model.js";
export { world } from "./core/world.js";
export type {
  AccessWorld,
  WorldActor,
  WorldEntity,
  WorldExpect,
  WorldMembers,
  WorldPerson,
  WorldSubject,
  WorldVerbs,
  WorldWrite,
} from "./core/world.js";
export { writeAccessArtifacts } from "./core/write-artifacts.js";
export type { AccessArtifactTarget } from "./core/write-artifacts.js";
export { zodEnumFromNames } from "./core/zod-enums.js";
