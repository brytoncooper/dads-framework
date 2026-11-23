import type { DslNode } from "../core/dsl-resource-types.js";
import type { DslPermissionTarget, DslRoleSlot, DslWildcardActorHolder } from "../core/dsl-types.js";
import type { EntityHandle } from "../core/entity-handle.js";
import { isWildcardHolder, type WildcardHolder } from "../core/holders.js";
import type { PermissionToken, RoleToken } from "../core/refs.js";
import type {
  Authorization,
  PermissionQuery,
  RelationshipFilter,
  RelationshipWrite,
  SubjectRef,
} from "../runtime/authorization.js";
import type { ControllableClock, TestDuration } from "./duration.js";

/** Any entity or DSL node whose wire name can identify an actor or resource. */
export type HarnessEntityTarget = EntityHandle | DslNode | { readonly wireName: string };

/** Any subject value accepted directly by `.to(...)` or `.from(...)`. */
export type HarnessSubjectInput = SubjectRef | WildcardHolder | DslWildcardActorHolder;

/** Target for `grant(...)` / `revoke(...)`: either a `(roleToken, resourceId)` pair or a `resource(id).role` slot. */
export type HarnessRoleTarget = {
  readonly entityWireName: string;
  readonly roleName: string;
  readonly resourceId: string;
};

/** Target for `assertCan(...)` / `assertCannot(...)`: either a `(permissionToken, resourceId)` pair or `resource(id).perm`. */
export type HarnessPermissionTarget = {
  readonly entityWireName: string;
  readonly permissionName: string;
  readonly resourceId: string;
};

export type MatrixDecision = "allow" | "deny";

export type MatrixRow = readonly [actor: SubjectRef, expected: readonly MatrixDecision[]];

export type PermissionMatrixSpec = {
  readonly permissions: readonly PermissionToken[];
  readonly cases: readonly MatrixRow[];
};

export type GrantBuilder = {
  readonly expiringIn: (duration: TestDuration) => GrantBuilder;
  readonly expiringAt: (expiresAt: Date) => GrantBuilder;
  readonly to: {
    (subject: HarnessSubjectInput): void;
    (entity: HarnessEntityTarget, id: string): void;
  };
};

export type RevokeBuilder = {
  readonly from: {
    (subject: HarnessSubjectInput): void;
    (entity: HarnessEntityTarget, id: string): void;
  };
  readonly all: () => void;
};

export type ScenarioStep =
  | {
      readonly kind: "grant";
      readonly write: RelationshipWrite;
      readonly expiresIn?: TestDuration;
    }
  | {
      readonly kind: "revoke";
      readonly filter: RelationshipFilter;
    }
  | {
      readonly kind: "advance-time";
      readonly duration: TestDuration;
    }
  | {
      readonly kind: "set-time";
      readonly time: Date | number;
    }
  | {
      readonly kind: "assert-check";
      readonly query: PermissionQuery;
      readonly expected: boolean;
    }
  | {
      readonly kind: "assert-visible";
      readonly actor: SubjectRef;
      readonly permission: PermissionToken;
      readonly expectedIds: readonly string[];
    }
  | {
      readonly kind: "assert-matrix";
      readonly resourceType: string;
      readonly resourceId: string;
      readonly spec: PermissionMatrixSpec;
    };

export type AccessScenarioVerbs = {
  readonly actor: (target: HarnessEntityTarget, id: string) => SubjectRef;
  readonly members: (role: RoleToken, resourceId: string) => SubjectRef;
  readonly everyone: (target: HarnessEntityTarget) => SubjectRef;
  readonly grant: {
    (slot: DslRoleSlot): GrantBuilder;
    (role: RoleToken, resourceId: string): GrantBuilder;
  };
  readonly revoke: {
    (slot: DslRoleSlot): RevokeBuilder;
    (role: RoleToken, resourceId: string): RevokeBuilder;
  };
  readonly advanceTime: (duration: TestDuration) => void;
  readonly setTime: (nextTime: Date | number) => void;
  readonly assertCan: {
    (actor: SubjectRef, target: DslPermissionTarget): void;
    (actor: SubjectRef, permission: PermissionToken, resourceId: string): void;
  };
  readonly assertCannot: {
    (actor: SubjectRef, target: DslPermissionTarget): void;
    (actor: SubjectRef, permission: PermissionToken, resourceId: string): void;
  };
  readonly assertVisible: (actor: SubjectRef, permission: PermissionToken, expectedIds: readonly string[]) => void;
  readonly assertMatrix: (target: HarnessEntityTarget, resourceId: string, spec: PermissionMatrixSpec) => void;
};

export type ProveAccessOptions = {
  readonly authorization?: Authorization;
  readonly clock?: ControllableClock;
  readonly startTime?: Date | number;
};

export function resolveWireName(target: HarnessEntityTarget): string {
  return "handle" in target ? target.handle.wireName : target.wireName;
}

function isHarnessEntityTarget(value: HarnessSubjectInput | HarnessEntityTarget): value is HarnessEntityTarget {
  if ("handle" in value && typeof value.handle === "object") return true;
  return "wireName" in value && typeof value.wireName === "string";
}

export function resolveSubjectInput(first: HarnessSubjectInput | HarnessEntityTarget, secondId?: string): SubjectRef {
  if (secondId !== undefined) {
    if (isHarnessEntityTarget(first)) {
      return { type: resolveWireName(first), id: secondId };
    }
    throw new Error("Expected an actor or resource definition before id");
  }
  if (isWildcardHolder(first)) {
    return { type: first.entity.wireName, id: "*" };
  }
  if ("type" in first && "id" in first) {
    if ("kind" in first && first.kind === "resource-ref") {
      return { type: first.type, id: first.id };
    }
    return typeof first.relation === "string"
      ? { type: first.type, id: first.id, relation: first.relation }
      : { type: first.type, id: first.id };
  }
  throw new Error(
    "Invalid subject passed to access test harness; pass a SubjectRef, user(id), user.anyone, or (resource, id).",
  );
}

export function resolveRoleTarget(roleOrSlot: RoleToken | DslRoleSlot, resourceId?: string): HarnessRoleTarget {
  if ("kind" in roleOrSlot && roleOrSlot.kind === "dsl-role-slot") {
    return {
      entityWireName: roleOrSlot.entityWireName,
      roleName: roleOrSlot.roleName,
      resourceId: roleOrSlot.resource.id,
    };
  }
  if (resourceId === undefined) {
    throw new Error(`Missing resourceId for role "${roleOrSlot.entityWireName}#${roleOrSlot.roleName}"`);
  }
  return {
    entityWireName: roleOrSlot.entityWireName,
    roleName: roleOrSlot.roleName,
    resourceId,
  };
}

export function resolvePermissionTarget(
  permissionOrTarget: PermissionToken | DslPermissionTarget,
  resourceId?: string,
): HarnessPermissionTarget {
  if ("kind" in permissionOrTarget && permissionOrTarget.kind === "dsl-permission-target") {
    return {
      entityWireName: permissionOrTarget.entityWireName,
      permissionName: permissionOrTarget.permissionName,
      resourceId: permissionOrTarget.resource.id,
    };
  }
  if (resourceId === undefined) {
    throw new Error(
      `Missing resourceId for permission "${permissionOrTarget.entityWireName}#${permissionOrTarget.permissionName}"`,
    );
  }
  return {
    entityWireName: permissionOrTarget.entityWireName,
    permissionName: permissionOrTarget.permissionName,
    resourceId,
  };
}
