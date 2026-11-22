import type { AccessModel } from "./access-model.js";
import { parentRoleNameOf } from "./dsl-actor.js";
import { emitAccessIr } from "./emit-ir.js";
import type {
  AccessIrDefinition,
  AccessIrPermission,
  AccessIrRole,
  AccessIrSubject,
  AccessIrTerm,
} from "./ir.js";

type ParentLink = {
  readonly parentWireName: string;
  readonly roleName: string;
};

function formatSubject(subject: AccessIrSubject): string {
  const base =
    subject.kind === "type"
      ? subject.wireName
      : subject.kind === "wildcard"
        ? `${subject.wireName}:*`
        : `${subject.wireName}#${subject.relation}`;
  return subject.expiration === true ? `${base} [expiring]` : base;
}

function formatRole(role: AccessIrRole): string {
  const subjects = role.subjects.map(formatSubject).join(" | ");
  return `${role.name} (${subjects})`;
}

function formatTerm(term: AccessIrTerm): string {
  if (term.kind === "role" || term.kind === "permission") return term.name;
  if (term.kind === "through") {
    return `${term.roleName}->${term.targetPermission}`;
  }
  if (term.kind === "through-all") {
    return `${term.roleName}.all(${term.targetPermission})`;
  }
  if (term.kind === "or") {
    return term.terms.map(formatTerm).join(" + ");
  }
  if (term.kind === "excluding") {
    return `(${formatTerm(term.term)}) - (${formatTerm(term.banned)})`;
  }
  if (term.kind === "gated") {
    return `(${formatTerm(term.term)} & ${formatTerm(term.condition)})`;
  }
  return `(${formatTerm(term.left)} & ${formatTerm(term.right)})`;
}

function formatTerms(terms: readonly AccessIrTerm[]): string {
  return terms.map(formatTerm).join(" + ");
}

function isRecursiveDefinition(def: AccessIrDefinition): boolean {
  return def.roles.some((role) =>
    role.subjects.some(
      (subject) => subject.kind === "type" && subject.wireName === def.wireName,
    ),
  );
}

function singleTypeSubjectWireName(role: AccessIrRole): string | undefined {
  if (role.subjects.length !== 1) return undefined;
  const only = role.subjects[0];
  if (only === undefined || only.kind !== "type") return undefined;
  return only.wireName;
}

function findParentLink(
  def: AccessIrDefinition,
  resourceWireNames: ReadonlySet<string>,
): ParentLink | undefined {
  for (const role of def.roles) {
    const target = singleTypeSubjectWireName(role);
    if (
      target !== undefined &&
      target !== def.wireName &&
      resourceWireNames.has(target) &&
      role.name === parentRoleNameOf(target)
    ) {
      return { parentWireName: target, roleName: role.name };
    }
  }
  return undefined;
}

function createsCycle(
  childWire: string,
  candidateParent: string,
  parentByChild: ReadonlyMap<string, ParentLink>,
): boolean {
  let cursor: string | undefined = candidateParent;
  const seen = new Set<string>([childWire]);
  while (cursor !== undefined) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = parentByChild.get(cursor)?.parentWireName;
  }
  return false;
}

function buildHierarchy(resources: readonly AccessIrDefinition[]): {
  readonly roots: readonly AccessIrDefinition[];
  readonly childrenByParent: ReadonlyMap<string, readonly AccessIrDefinition[]>;
  readonly parentByChild: ReadonlyMap<string, ParentLink>;
} {
  const wireNames = new Set(resources.map((def) => def.wireName));
  const parentByChild = new Map<string, ParentLink>();
  const childrenByParent = new Map<string, AccessIrDefinition[]>();
  const roots: AccessIrDefinition[] = [];

  for (const def of resources) {
    const link = findParentLink(def, wireNames);
    if (
      link !== undefined &&
      !createsCycle(def.wireName, link.parentWireName, parentByChild)
    ) {
      parentByChild.set(def.wireName, link);
      const list = childrenByParent.get(link.parentWireName) ?? [];
      list.push(def);
      childrenByParent.set(link.parentWireName, list);
    } else {
      roots.push(def);
    }
  }
  return { roots, childrenByParent, parentByChild };
}

function termHasParentThrough(
  term: AccessIrTerm,
  parentRoleName: string,
): boolean {
  if (term.kind === "through" || term.kind === "through-all") {
    return term.roleName === parentRoleName;
  }
  if (term.kind === "or") {
    return term.terms.some((entry) =>
      termHasParentThrough(entry, parentRoleName),
    );
  }
  if (term.kind === "excluding") {
    return termHasParentThrough(term.term, parentRoleName);
  }
  if (term.kind === "gated") {
    return termHasParentThrough(term.term, parentRoleName);
  }
  if (term.kind === "both") {
    return (
      termHasParentThrough(term.left, parentRoleName) ||
      termHasParentThrough(term.right, parentRoleName)
    );
  }
  return false;
}

function permissionOriginTag(
  permission: AccessIrPermission,
  parentRoleName: string | undefined,
): string {
  if (parentRoleName === undefined) return "";
  const isPureInherited =
    permission.terms.length === 1 &&
    permission.terms[0]?.kind === "through" &&
    permission.terms[0].roleName === parentRoleName &&
    permission.terms[0].targetPermission === permission.name;
  if (isPureInherited) return " [inherited]";
  const usesParent = permission.terms.some((term) =>
    termHasParentThrough(term, parentRoleName),
  );
  return usesParent ? " [inherited+local]" : " [local]";
}

type TreeSection =
  | { readonly kind: "roles"; readonly text: string }
  | {
      readonly kind: "can";
      readonly permissions: readonly AccessIrPermission[];
    }
  | { readonly kind: "child"; readonly def: AccessIrDefinition };

function sectionsForDefinition(
  def: AccessIrDefinition,
  children: readonly AccessIrDefinition[],
): readonly TreeSection[] {
  const sections: TreeSection[] = [];
  if (def.roles.length > 0) {
    sections.push({
      kind: "roles",
      text: `roles: ${def.roles.map(formatRole).join(", ")}`,
    });
  }
  if (def.permissions.length > 0) {
    sections.push({ kind: "can", permissions: def.permissions });
  }
  for (const child of children) {
    sections.push({ kind: "child", def: child });
  }
  return sections;
}

function appendPermissions(
  lines: string[],
  permissions: readonly AccessIrPermission[],
  parentRoleName: string | undefined,
  indent: string,
): void {
  for (let index = 0; index < permissions.length; index += 1) {
    const perm = permissions[index];
    if (perm === undefined) continue;
    const isLast = index === permissions.length - 1;
    const branch = isLast ? "└── " : "├── ";
    const tag = permissionOriginTag(perm, parentRoleName);
    lines.push(
      `${indent}${branch}${perm.name} = ${formatTerms(perm.terms)}${tag}`,
    );
  }
}

function renderNode(
  def: AccessIrDefinition,
  childrenByParent: ReadonlyMap<string, readonly AccessIrDefinition[]>,
  parentByChild: ReadonlyMap<string, ParentLink>,
  prefix: string,
  lines: string[],
): void {
  const children = childrenByParent.get(def.wireName) ?? [];
  const parentRoleName = parentByChild.get(def.wireName)?.roleName;
  const sections = sectionsForDefinition(def, children);

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (section === undefined) continue;
    const isLast = index === sections.length - 1;
    const branch = isLast ? "└── " : "├── ";
    const nextPrefix = `${prefix}${isLast ? "    " : "│   "}`;

    if (section.kind === "roles") {
      lines.push(`${prefix}${branch}${section.text}`);
    } else if (section.kind === "can") {
      lines.push(`${prefix}${branch}can:`);
      appendPermissions(lines, section.permissions, parentRoleName, nextPrefix);
    } else {
      const suffix = isRecursiveDefinition(section.def) ? " (recursive)" : "";
      lines.push(`${prefix}${branch}${section.def.wireName}${suffix}`);
      renderNode(
        section.def,
        childrenByParent,
        parentByChild,
        nextPrefix,
        lines,
      );
    }
  }
}

/**
 * Render an `AccessModel` as a deterministic, human-readable ASCII tree
 * showing actors, top-level resources, roles, permissions, and nested children.
 */
export function formatAccessTree(model: AccessModel): string {
  const definitions = emitAccessIr(model);
  const actors = definitions.filter(
    (def) => def.roles.length === 0 && def.permissions.length === 0,
  );
  const resources = definitions.filter(
    (def) => def.roles.length > 0 || def.permissions.length > 0,
  );
  const { roots, childrenByParent, parentByChild } = buildHierarchy(resources);

  const blocks: string[] = [];
  if (actors.length > 0) {
    blocks.push(`actors: ${actors.map((entry) => entry.wireName).join(", ")}`);
  }
  for (const root of roots) {
    const suffix = isRecursiveDefinition(root) ? " (recursive)" : "";
    const lines = [`${root.wireName}${suffix}`];
    renderNode(root, childrenByParent, parentByChild, "", lines);
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}
