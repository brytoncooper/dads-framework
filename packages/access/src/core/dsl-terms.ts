import { both, excluding, through, throughAll } from "./combinators.js";
import type {
  DslEveryProxy,
  DslPermissionExpr,
  DslRoleRef,
  DslTerm,
  DslTermInput,
} from "./dsl-types.js";
import { permissionToken } from "./refs.js";
import type { PermissionTerm, RoleToken } from "./refs.js";

const roleRefTargetResolvers = new WeakMap<object, () => string>();

export function isDslTerm(value: unknown): value is DslTerm {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "dsl-term"
  );
}

function isDslTermList(value: DslTermInput): value is readonly DslTermInput[] {
  return Array.isArray(value);
}

function flattenOrTerms(
  inputs: readonly DslTermInput[],
): readonly PermissionTerm[] {
  const result: PermissionTerm[] = [];
  for (const input of inputs) {
    if (isDslTermList(input)) {
      result.push(...flattenOrTerms(input));
      continue;
    }
    const unwrapped = isDslTerm(input) ? input.term : input;
    if (unwrapped.kind === "or") {
      result.push(...unwrapped.terms);
    } else {
      result.push(unwrapped);
    }
  }
  return result;
}

export function unwrapDslTerm(input: DslTermInput): PermissionTerm {
  if (!isDslTermList(input)) {
    return isDslTerm(input) ? input.term : input;
  }
  const flattened = flattenOrTerms(input);
  const first = flattened[0];
  if (first === undefined) {
    throw new Error("permission expression cannot be an empty list");
  }
  if (flattened.length === 1) {
    return first;
  }
  return { kind: "or", terms: flattened };
}

export function dslTerm(term: PermissionTerm): DslTerm {
  const wrapped: DslTerm = {
    kind: "dsl-term",
    term,
    or: (...others) => anyOf(wrapped, ...others),
    and: (...others) => allOf(wrapped, ...others),
    unless: (blocked) => dslTerm(excluding(term, unwrapDslTerm(blocked))),
  };
  return wrapped;
}

/** Disjunction (OR) across one or more permission terms. */
export function anyOf(...terms: readonly DslTermInput[]): DslTerm {
  const flattened = flattenOrTerms(terms);
  const first = flattened[0];
  if (first === undefined) {
    throw new Error("anyOf() requires at least one permission term");
  }
  if (flattened.length === 1) {
    return dslTerm(first);
  }
  return dslTerm({ kind: "or", terms: flattened });
}

/** Conjunction (AND) across one or more permission terms. */
export function allOf(...terms: readonly DslTermInput[]): DslTerm {
  const firstInput = terms[0];
  if (firstInput === undefined) {
    throw new Error("allOf() requires at least one permission term");
  }
  let combined = unwrapDslTerm(firstInput);
  for (let index = 1; index < terms.length; index += 1) {
    const next = terms[index];
    if (next !== undefined) {
      combined = both(combined, unwrapDslTerm(next));
    }
  }
  return dslTerm(combined);
}

function isDslRoleRefValue<TargetPerms extends string>(
  value: unknown,
): value is DslRoleRef<TargetPerms> {
  return typeof value === "object" && value !== null;
}

function isDslEveryProxyValue<TargetPerms extends string>(
  value: unknown,
): value is DslEveryProxy<TargetPerms> {
  return typeof value === "object" && value !== null;
}

function readTermMethod(base: DslTerm, propertyName: string): unknown {
  if (propertyName === "kind") return base.kind;
  if (propertyName === "term") return base.term;
  if (propertyName === "or") return base.or;
  if (propertyName === "and") return base.and;
  if (propertyName === "unless") return base.unless;
  return undefined;
}

export function createRoleRef<TargetPerms extends string>(
  token: RoleToken,
  resolveTargetWireName: () => string,
): DslRoleRef<TargetPerms> {
  const base = dslTerm(token);
  const proxy = new Proxy(base, {
    get(_target, propertyName): unknown {
      if (typeof propertyName !== "string") return undefined;
      if (propertyName === "$roleToken") return token;
      const method = readTermMethod(base, propertyName);
      if (method !== undefined) return method;
      if (propertyName === "then" || propertyName === "toJSON") {
        return undefined;
      }
      return dslTerm(
        through(token, permissionToken(resolveTargetWireName(), propertyName)),
      );
    },
  });
  if (!isDslRoleRefValue<TargetPerms>(proxy)) {
    throw new Error(`failed to create role ref for ${token.roleName}`);
  }
  roleRefTargetResolvers.set(proxy, resolveTargetWireName);
  return proxy;
}

/**
 * Universal intersection arrow (`role.all(permission)`): requires the subject
 * to hold the chosen permission on every resource linked through `link`.
 */
export function every<TargetPerms extends string>(
  link: DslRoleRef<TargetPerms>,
): DslEveryProxy<TargetPerms> {
  const token = link.$roleToken;
  const resolveTarget =
    roleRefTargetResolvers.get(link) ?? (() => token.entityWireName);
  const proxy = new Proxy(
    {},
    {
      get(_target, propertyName): unknown {
        if (
          typeof propertyName !== "string" ||
          propertyName === "then" ||
          propertyName === "toJSON"
        ) {
          return undefined;
        }
        return dslTerm(
          throughAll(token, permissionToken(resolveTarget(), propertyName)),
        );
      },
    },
  );
  if (!isDslEveryProxyValue<TargetPerms>(proxy)) {
    throw new Error(`failed to create every() proxy for ${token.roleName}`);
  }
  return proxy;
}

export function normalizePermissionExpr(
  expr: DslPermissionExpr,
): readonly PermissionTerm[] {
  const unwrapped = unwrapDslTerm(expr);
  if (unwrapped.kind === "or") {
    return unwrapped.terms;
  }
  return [unwrapped];
}

function targetNameOf(term: {
  readonly target:
    | { readonly kind: "permission"; readonly permissionName: string }
    | { readonly kind: "role"; readonly roleName: string };
}): string {
  return term.target.kind === "permission"
    ? term.target.permissionName
    : term.target.roleName;
}

function childTermsOf(term: PermissionTerm): readonly PermissionTerm[] {
  if (term.kind === "or") return term.terms;
  if (term.kind === "gated") return [term.term, term.condition];
  if (term.kind === "excluding") return [term.term, term.banned];
  if (term.kind === "both") return [term.left, term.right];
  return [];
}

function singleTermReferencesThrough(
  term: PermissionTerm,
  roleName: string,
  targetPermission: string,
): boolean {
  if (term.kind === "through" || term.kind === "through-all") {
    return (
      term.role.roleName === roleName && targetNameOf(term) === targetPermission
    );
  }
  return childTermsOf(term).some((entry) =>
    singleTermReferencesThrough(entry, roleName, targetPermission),
  );
}

export function termsReferenceThrough(
  terms: readonly PermissionTerm[],
  roleName: string,
  targetPermission: string,
): boolean {
  return terms.some((term) =>
    singleTermReferencesThrough(term, roleName, targetPermission),
  );
}
