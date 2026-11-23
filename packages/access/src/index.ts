export type {
  AccessMigrationKind,
  AccessMigrationMeta,
  AccessModel,
  ResolvedAccessDefinition,
  ResolvedGranting,
} from "./core/access-model.js";
export { accessIrDefinitionsDiff, accessIrDiff } from "./core/compare-access-ir.js";
export { compileAccessFromIr } from "./core/compile-ir.js";
export { actor } from "./core/dsl-actor.js";
export { compileAccess } from "./core/dsl-compile.js";
export { formatAccessTree } from "./core/dsl-format-tree.js";
export { resource } from "./core/dsl-resource.js";
export type {
  AnyDslChildSpec,
  CompileAccessOptions,
  DslCanContext,
  DslChildSpec,
  DslInheritOption,
  DslNode,
  DslResource,
  DslResourceIdOf,
  DslResourceInstance,
  MaterializeChildResource,
  ResolvedInheritedPerms,
} from "./core/dsl-resource-types.js";
export { allOf, anyOf, every } from "./core/dsl-terms.js";
export type {
  ActorRef,
  AllowedSubjectForHolder,
  AnyDslResource,
  AnyDslRoleSlot,
  DslActor,
  DslActorOptions,
  DslEveryProxy,
  DslExpirableActorHolder,
  DslExpirableUsersetHolder,
  DslExpirableWildcardHolder,
  DslGrantingSpec,
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
  ResourceIdOf,
  ResourceSubjectRef,
  SharedParentPermissions,
  SubjectMapFromRoles,
} from "./core/dsl-types.js";
export { emitAccessIr } from "./core/emit-ir.js";
export { emitTypeScript, emitTypeScriptFromZed } from "./core/emit-typescript.js";
export { emitZed, emitZedForDefinitions } from "./core/emit-zed.js";
export type { EntityHandle } from "./core/entity-handle.js";
export { GENERATED_ZED_HEADER, isGeneratedByAccessKit } from "./core/generated-header.js";
export type { ExpirableHolder, RoleValue, SingleRoleValue, UsersetHolder, WildcardHolder } from "./core/holders.js";
export type { AccessIrDefinition, AccessIrPermission, AccessIrRole, AccessIrSubject, AccessIrTerm } from "./core/ir.js";
export { parseZed } from "./core/parse-zed.js";
export { isPermissionToken, isRoleToken, permissionToken, roleToken } from "./core/refs.js";
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
