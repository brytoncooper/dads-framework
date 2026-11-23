/**
 * Compiles a record permission's rule tree into a scope plan: which scope ids
 * to ask SpiceDB for, and how the record's own columns combine them. It is a
 * second walk of the same tree `emit-zed.ts` walks to write the schema, so a
 * list filter is never written by hand per model. A page's rows are still
 * re-checked one bulk call later, so a wrong plan can mis-count but never
 * leak a row.
 */
import type { AccessModel } from "./access-model.js";
import { emitAccessIr } from "./emit-ir.js";
import type { AccessIrDefinition, AccessIrTerm } from "./ir.js";
import type { RoleBinding } from "./scope-bindings.js";
import { allOf, anyOf, notOf } from "./scope-plan-simplify.js";

// ─── Public shapes ───────────────────────────────────────────────────────────

/**
 * Ask SpiceDB which `targetType` ids the caller holds `targetPermission` on;
 * the record matches when `role`'s binding points at one of them.
 */
export type ScopeLookupPlan = {
  readonly kind: "lookup";
  readonly role: string;
  readonly targetType: string;
  readonly targetPermission: string;
};

/**
 * The record matches when the `targetType` record its `role` points at
 * matches `plan` (document → folder → workspace).
 */
export type ScopeViaPlan = {
  readonly kind: "via";
  readonly role: string;
  readonly targetType: string;
  readonly plan: ScopePlan;
};

export type ScopePlan =
  | ScopeLookupPlan
  | ScopeViaPlan
  | { readonly kind: "tag"; readonly role: string }
  | { readonly kind: "direct"; readonly role: string }
  | { readonly kind: "any"; readonly plans: readonly ScopePlan[] }
  | { readonly kind: "all"; readonly plans: readonly ScopePlan[] }
  | { readonly kind: "not"; readonly plan: ScopePlan };

/** One distinct question a plan needs SpiceDB to answer. */
export type ScopeLookupTarget = {
  readonly targetType: string;
  readonly targetPermission: string;
};

/** Why a plan could not be compiled, and the rule path that led there. */
export type ScopePlanFailure = {
  readonly path: string;
  readonly message: string;
};

/**
 * Everything the compiler reads: the rule trees, the explicit
 * `allowLookupResourcesOn` set, and each record's role bindings keyed by wire
 * name.
 */
export type ScopeSchema = {
  readonly definitions: readonly AccessIrDefinition[];
  readonly lookupAllowlist: ReadonlySet<string>;
  readonly bindings: ReadonlyMap<string, Readonly<Record<string, RoleBinding>>>;
};

// ─── Entry points ────────────────────────────────────────────────────────────

/**
 * Compile `permissionName` on a registered record definition. Throws, naming
 * every failure, when the plan cannot be compiled.
 */
export function compileScopePlan(model: AccessModel, definitionWireName: string, permissionName: string): ScopePlan {
  return compileScopePlanInSchema(scopeSchema(model), definitionWireName, permissionName);
}

export function compileScopePlanInSchema(
  schema: ScopeSchema,
  definitionWireName: string,
  permissionName: string,
): ScopePlan {
  const result = planScope(schema, definitionWireName, permissionName);
  if (result.plan === undefined) {
    const lines = result.failures.map((failure) => `  ${failure.path}: ${failure.message}`);
    throw new Error(`cannot compile a scope plan for ${definitionWireName}.${permissionName}:\n${lines.join("\n")}`);
  }
  return result.plan;
}

/**
 * Compile and collect every failure instead of throwing on the first; the
 * plan is present only when there are none.
 */
export function planScope(
  schema: ScopeSchema,
  definitionWireName: string,
  permissionName: string,
): {
  readonly plan: ScopePlan | undefined;
  readonly failures: readonly ScopePlanFailure[];
} {
  const failures: ScopePlanFailure[] = [];
  const plan = planPermission({ schema, failures }, definitionWireName, permissionName, [], []);
  return { plan: failures.length === 0 ? plan : undefined, failures };
}

/** Lower the composed access definitions, allowlist, and bindings for the scope planner. */
export function scopeSchema(model: AccessModel): ScopeSchema {
  const lookupAllowlist = new Set<string>(model.lookupResourceAllowlist ?? []);
  const bindings = new Map<string, Readonly<Record<string, RoleBinding>>>();
  for (const entry of model.bindings) {
    bindings.set(entry.entity.wireName, entry.roles);
  }
  return { definitions: emitAccessIr(model), lookupAllowlist, bindings };
}

// ─── Walk ────────────────────────────────────────────────────────────────────

type Walk = {
  readonly schema: ScopeSchema;
  readonly failures: ScopePlanFailure[];
};

/** Where the walk stands: one record definition, and how it got there. */
type Place = {
  readonly definition: AccessIrDefinition;
  readonly roles: Readonly<Record<string, RoleBinding>>;
  readonly path: readonly string[];
  readonly visiting: readonly string[];
};

function fail(walk: Walk, path: readonly string[], message: string): ScopePlan | undefined {
  const failure = { path: path.join(" → "), message };
  const alreadyReported = walk.failures.some((entry) => entry.path === failure.path && entry.message === message);
  if (!alreadyReported) {
    walk.failures.push(failure);
  }
  return undefined;
}

function planPermission(
  walk: Walk,
  wireName: string,
  permissionName: string,
  path: readonly string[],
  visiting: readonly string[],
): ScopePlan | undefined {
  const step = `${wireName}.${permissionName}`;
  const here = [...path, step];
  if (visiting.includes(step)) {
    return fail(walk, here, "cycle: the rules reach this permission again");
  }

  const definition = walk.schema.definitions.find((entry) => entry.wireName === wireName);
  if (definition === undefined) {
    return fail(walk, here, `no access definition named ${wireName}`);
  }
  const roles = walk.schema.bindings.get(wireName);
  if (roles === undefined) {
    return fail(walk, here, `${wireName} is not a record with scope bindings`);
  }

  return planAtPlace(walk, { definition, roles, path: here, visiting: [...visiting, step] }, permissionName);
}

function planAtPlace(walk: Walk, place: Place, permissionName: string): ScopePlan | undefined {
  const { definition } = place;
  const permission = definition.permissions.find((entry) => entry.name === permissionName);
  if (permission === undefined) {
    if (definition.roles.some((role) => role.name === permissionName)) {
      return planRole(walk, place, permissionName);
    }
    return fail(walk, place.path, `${definition.wireName} has no permission ${permissionName}`);
  }
  return anyOf(permission.terms.map((term) => planTerm(walk, place, term)));
}

function planNameRef(walk: Walk, place: Place, name: string) {
  const isPermission = place.definition.permissions.some((permission) => permission.name === name);
  return isPermission
    ? planPermission(walk, place.definition.wireName, name, place.path, place.visiting)
    : planRole(walk, place, name);
}

function planTerm(walk: Walk, place: Place, term: AccessIrTerm): ScopePlan | undefined {
  if (term.kind === "role" || term.kind === "permission") {
    return planNameRef(walk, place, term.name);
  }
  if (term.kind === "through") {
    return planThrough(walk, place, term.roleName, term.targetPermission);
  }
  if (term.kind === "through-all") {
    return fail(
      walk,
      place.path,
      `role ${term.roleName}.all(${term.targetPermission}) cannot be compiled to a scope plan`,
    );
  }
  if (term.kind === "or") {
    return anyOf(term.terms.map((entry) => planTerm(walk, place, entry)));
  }
  if (term.kind === "gated") {
    return allOf([planTerm(walk, place, term.term), planTerm(walk, place, term.condition)]);
  }
  if (term.kind === "both") {
    return allOf([planTerm(walk, place, term.left), planTerm(walk, place, term.right)]);
  }
  const banned = planTerm(walk, place, term.banned);
  return allOf([planTerm(walk, place, term.term), banned === undefined ? undefined : notOf(banned)]);
}

/** A role used directly as a term: only a tag or a sparse direct grant. */
function planRole(walk: Walk, place: Place, roleName: string): ScopePlan | undefined {
  const binding = place.roles[roleName];
  if (binding === undefined) {
    return fail(walk, place.path, `role ${roleName} is not bound`);
  }
  if (binding.kind === "tag") {
    return { kind: "tag", role: roleName };
  }
  if (binding.kind === "sparse-direct") {
    return { kind: "direct", role: roleName };
  }
  return fail(
    walk,
    place.path,
    `role ${roleName} is bound as ${binding.kind} but used directly; a direct role must be bound as tag or sparse-direct`,
  );
}

/** `role->targetPermission`: a scope lookup, or a walk into another record. */
function planThrough(walk: Walk, place: Place, roleName: string, targetPermission: string): ScopePlan | undefined {
  const binding = place.roles[roleName];
  if (binding === undefined) {
    fail(walk, place.path, `role ${roleName} is not bound`);
    return undefined;
  }
  if (binding.kind === "tag" || binding.kind === "sparse-direct") {
    fail(
      walk,
      place.path,
      `role ${roleName} is bound as ${binding.kind} and cannot be followed to ${targetPermission}`,
    );
    return undefined;
  }
  const role = place.definition.roles.find((entry) => entry.name === roleName);
  if (role === undefined) {
    fail(walk, place.path, `${place.definition.wireName} has no role ${roleName}`);
    return undefined;
  }

  return anyOf(
    role.subjects.map((subject) => {
      if (subject.kind !== "type") {
        fail(
          walk,
          place.path,
          `role ${roleName} holds ${subject.kind} subjects of ${subject.wireName}, which cannot be followed`,
        );
        return undefined;
      }
      return planTarget(walk, place, roleName, subject.wireName, targetPermission);
    }),
  );
}

function planTarget(
  walk: Walk,
  place: Place,
  roleName: string,
  targetType: string,
  targetPermission: string,
): ScopePlan | undefined {
  if (walk.schema.bindings.has(targetType)) {
    const plan = planPermission(walk, targetType, targetPermission, [...place.path, `via ${roleName}`], place.visiting);
    return plan === undefined ? undefined : { kind: "via", role: roleName, targetType, plan };
  }
  if (walk.schema.lookupAllowlist.has(targetType)) {
    return { kind: "lookup", role: roleName, targetType, targetPermission };
  }
  fail(
    walk,
    place.path,
    `role ${roleName} points at ${targetType}, which is neither in allowLookupResourcesOn nor a record with scope bindings`,
  );
  return undefined;
}

export { describeScopePlan, distinctScopeLookups } from "./scope-plan-read.js";
