export {
  asPermissionTerm,
  both,
  excluding,
  gated,
  through,
  throughAll,
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
export {
  emitTypeScript,
  emitTypeScriptFromZed,
} from "./core/emit-typescript.js";
export type {
  EmitTypeScriptOptions,
  EmitTypeScriptStyle,
} from "./core/emit-typescript.js";
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
export { membersOf, wildcard, withExpiration } from "./core/holders.js";
export type {
  ExpirableHolder,
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
  ThroughAllTerm,
  ThroughTerm,
} from "./core/refs.js";
export { accessModel } from "./core/access-model.js";
export type {
  AccessMigrationKind,
  AccessMigrationMeta,
  AccessModel,
  ResolvedAccessDefinition,
  ResolvedGranting,
} from "./core/access-model.js";
export { actor } from "./core/dsl-actor.js";
export { compileAccess } from "./core/dsl-compile.js";
export { formatAccessTree } from "./core/dsl-format-tree.js";
export { resource } from "./core/dsl-resource.js";
export { allOf, anyOf, every } from "./core/dsl-terms.js";
export type {
  AnyDslChildSpec,
  CompileAccessOptions,
  DslCanContext,
  DslChildSpec,
  DslInheritOption,
  DslNode,
  DslResource,
  DslResourceInstance,
  MaterializeChildResource,
  ResolvedInheritedPerms,
} from "./core/dsl-resource-types.js";
export type {
  ActorRef,
  AllowedSubjectForHolder,
  AnyDslResource,
  AnyDslRoleSlot,
  DslActor,
  DslActorOptions,
  DslEveryProxy,
  DslExpirableActorHolder,
  DslLazyResource,
  DslPermissionExpr,
  DslPermissionTarget,
  DslPermissionToken,
  DslRoleHolder,
  DslRoleRef,
  DslRoleSlot,
  DslRoleToken,
  DslRolesSpec,
  DslSubjectInput,
  DslTerm,
  DslTermInput,
  DslUsersetSubject,
  DslWildcardActorHolder,
  ParentRoleName,
  ResourceSubjectRef,
  SharedParentPermissions,
  SubjectMapFromRoles,
} from "./core/dsl-types.js";
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
