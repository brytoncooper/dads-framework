import { isGrantableRole } from "./grantable.js";
import { isEntityHandleHolder, isExpirableHolder, isUsersetHolder, isWildcardHolder } from "./holders.js";
import type { SingleRoleValue } from "./holders.js";
import type { AccessIrDefinition, AccessIrPermission, AccessIrRole, AccessIrSubject, AccessIrTerm } from "./ir.js";
import { isPermissionToken, isRoleToken } from "./refs.js";
import type { PermissionTerm, RoleHolder, ThroughAllTerm, ThroughTerm } from "./refs.js";
import type { AccessModel, ResolvedAccessDefinition } from "./access-model.js";

function isHolderList(holder: RoleHolder): holder is readonly SingleRoleValue[] {
  return Array.isArray(holder);
}

function markExpirable(subject: AccessIrSubject): AccessIrSubject {
  return { ...subject, expiration: true };
}

function subjectsForHolder(holder: RoleHolder): readonly AccessIrSubject[] {
  if (isHolderList(holder)) {
    return holder.flatMap((entry) => subjectsForHolder(entry));
  }
  if (isExpirableHolder(holder)) {
    return subjectsForHolder(holder.holder).map(markExpirable);
  }
  if (isGrantableRole(holder)) {
    const direct = subjectsForHolder(holder.directSubject);
    return holder.groupSubject === undefined ? direct : [...direct, ...subjectsForHolder(holder.groupSubject)];
  }
  if (isWildcardHolder(holder)) {
    return [{ kind: "wildcard", wireName: holder.entity.wireName }];
  }
  if (isUsersetHolder(holder)) {
    return [
      {
        kind: "userset",
        wireName: holder.entityWireName,
        relation: holder.roleName,
      },
    ];
  }
  if (isEntityHandleHolder(holder)) {
    return [{ kind: "type", wireName: holder.wireName }];
  }
  throw new Error("unknown role holder");
}

function irArrowTerm(term: ThroughTerm | ThroughAllTerm): AccessIrTerm {
  return {
    kind: term.kind,
    roleName: term.role.roleName,
    targetPermission: isPermissionToken(term.target) ? term.target.permissionName : term.target.roleName,
  };
}

function irTerm(term: PermissionTerm, ownerWireName: string): AccessIrTerm {
  if (isRoleToken(term)) {
    return { kind: "role", name: term.roleName };
  }
  if (isPermissionToken(term)) {
    if (term.entityWireName !== ownerWireName) {
      throw new Error(
        `permission ${term.entityWireName}#${term.permissionName} cannot be a term on ${ownerWireName}; use through()`,
      );
    }
    return { kind: "permission", name: term.permissionName };
  }
  if (term.kind === "through" || term.kind === "through-all") {
    return irArrowTerm(term);
  }
  if (term.kind === "gated") {
    return {
      kind: "gated",
      term: irTerm(term.term, ownerWireName),
      condition: irTerm(term.condition, ownerWireName),
    };
  }
  if (term.kind === "excluding") {
    return {
      kind: "excluding",
      term: irTerm(term.term, ownerWireName),
      banned: irTerm(term.banned, ownerWireName),
    };
  }
  if (term.kind === "or") {
    return {
      kind: "or",
      terms: term.terms.map((entry) => irTerm(entry, ownerWireName)),
    };
  }
  return {
    kind: "both",
    left: irTerm(term.left, ownerWireName),
    right: irTerm(term.right, ownerWireName),
  };
}

function irRoles(definition: ResolvedAccessDefinition): readonly AccessIrRole[] {
  return Object.values(definition.roles).map((role) => ({
    name: role.roleName,
    subjects: subjectsForHolder(role.holder),
  }));
}

/**
 * Lower sealed `access()` definitions into the schema IR the emitter and
 * visualizer share.
 */
export function emitAccessIr(model: AccessModel): readonly AccessIrDefinition[] {
  return model.definitions.map(irDefinition);
}

function irDefinition(definition: ResolvedAccessDefinition): AccessIrDefinition {
  const owner = definition.entity.wireName;
  return {
    wireName: owner,
    roles: irRoles(definition),
    permissions: Object.entries(definition.expressions).map(([name, terms]) => irPermission(owner, name, terms)),
  };
}

function irPermission(owner: string, name: string, terms: readonly PermissionTerm[]): AccessIrPermission {
  return { name, terms: terms.map((term) => irTerm(term, owner)) };
}
