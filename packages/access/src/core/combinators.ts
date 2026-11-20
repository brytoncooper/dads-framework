import type {
  BothTerm,
  ExcludingTerm,
  GatedTerm,
  PermissionTerm,
  PermissionToken,
  RoleToken,
  ThroughTerm,
} from "./refs.js";

export type PermissionTermInput = PermissionTerm | readonly PermissionTerm[];

function isTermList(
  value: PermissionTermInput,
): value is readonly PermissionTerm[] {
  return Array.isArray(value);
}

/**
 * Nested OR. A permission's top-level array is already OR; this wraps a
 * list so `gated` / `excluding` / `both` can take a union.
 */
export function asPermissionTerm(value: PermissionTermInput): PermissionTerm {
  if (!isTermList(value)) {
    return value;
  }
  if (value.length === 0) {
    throw new Error("permission term list is empty");
  }
  if (value.length === 1) {
    const only = value[0];
    if (only === undefined) {
      throw new Error("permission term list has a hole");
    }
    return only;
  }
  return { kind: "or", terms: value };
}

/**
 * Arrow: the role's holder must also hold `target` on the related object.
 * `target` may be a permission or a role.
 */
export function through(
  role: RoleToken,
  target: PermissionToken | RoleToken,
): ThroughTerm {
  return { kind: "through", role, target };
}

/**
 * Permission intersection: `term` only when `condition` is also true.
 */
export function gated(
  term: PermissionTermInput,
  condition: PermissionTermInput,
): GatedTerm {
  return {
    kind: "gated",
    term: asPermissionTerm(term),
    condition: asPermissionTerm(condition),
  };
}

/**
 * Exclusion: `term` minus `banned`.
 */
export function excluding(
  term: PermissionTermInput,
  banned: PermissionTermInput,
): ExcludingTerm {
  return {
    kind: "excluding",
    term: asPermissionTerm(term),
    banned: asPermissionTerm(banned),
  };
}

/**
 * General intersection of two terms.
 */
export function both(
  left: PermissionTermInput,
  right: PermissionTermInput,
): BothTerm {
  return {
    kind: "both",
    left: asPermissionTerm(left),
    right: asPermissionTerm(right),
  };
}
