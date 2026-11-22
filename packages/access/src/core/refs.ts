import type { RoleValue } from "./holders.js";

export type RoleHolder = RoleValue;

export type RoleToken = {
  readonly kind: "role";
  readonly entityWireName: string;
  readonly roleName: string;
  readonly holder: RoleHolder;
};

export type PermissionToken = {
  readonly kind: "permission";
  readonly entityWireName: string;
  readonly permissionName: string;
};

export type ThroughTerm = {
  readonly kind: "through";
  readonly role: RoleToken;
  readonly target: PermissionToken | RoleToken;
};

export type ThroughAllTerm = {
  readonly kind: "through-all";
  readonly role: RoleToken;
  readonly target: PermissionToken | RoleToken;
};

export type GatedTerm = {
  readonly kind: "gated";
  readonly term: PermissionTerm;
  readonly condition: PermissionTerm;
};

export type ExcludingTerm = {
  readonly kind: "excluding";
  readonly term: PermissionTerm;
  readonly banned: PermissionTerm;
};

export type BothTerm = {
  readonly kind: "both";
  readonly left: PermissionTerm;
  readonly right: PermissionTerm;
};

export type OrTerm = {
  readonly kind: "or";
  readonly terms: readonly PermissionTerm[];
};

export type PermissionTerm =
  | RoleToken
  | PermissionToken
  | ThroughTerm
  | ThroughAllTerm
  | GatedTerm
  | ExcludingTerm
  | BothTerm
  | OrTerm;

export function permissionToken(
  entityWireName: string,
  permissionName: string,
): PermissionToken {
  return {
    kind: "permission",
    entityWireName,
    permissionName,
  };
}

export function roleToken(
  entityWireName: string,
  roleName: string,
  holder: RoleHolder,
): RoleToken {
  return {
    kind: "role",
    entityWireName,
    roleName,
    holder,
  };
}

export function isPermissionToken(value: unknown): value is PermissionToken {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "permission"
  );
}

export function isRoleToken(value: unknown): value is RoleToken {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "role"
  );
}
