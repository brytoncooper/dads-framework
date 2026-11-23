import type { AccessIrDefinition, AccessIrPermission, AccessIrRole, AccessIrSubject, AccessIrTerm } from "./ir.js";

function subjectKey(subject: AccessIrSubject): string {
  const suffix = subject.expiration === true ? ":expiration" : "";
  if (subject.kind === "type") {
    return `type:${subject.wireName}${suffix}`;
  }
  if (subject.kind === "wildcard") {
    return `wildcard:${subject.wireName}${suffix}`;
  }
  return `userset:${subject.wireName}#${subject.relation}${suffix}`;
}

function normalizeTerm(term: AccessIrTerm): AccessIrTerm {
  if (term.kind === "gated") {
    return {
      kind: "both",
      left: normalizeTerm(term.term),
      right: normalizeTerm(term.condition),
    };
  }
  if (term.kind === "both") {
    return {
      kind: "both",
      left: normalizeTerm(term.left),
      right: normalizeTerm(term.right),
    };
  }
  if (term.kind === "excluding") {
    return {
      kind: "excluding",
      term: normalizeTerm(term.term),
      banned: normalizeTerm(term.banned),
    };
  }
  if (term.kind === "or") {
    return { kind: "or", terms: sortTerms(term.terms.map(normalizeTerm)) };
  }
  if (term.kind === "permission") {
    return { kind: "role", name: term.name };
  }
  return term;
}

function termKey(term: AccessIrTerm): string {
  const normalized = normalizeTerm(term);
  if (normalized.kind === "role" || normalized.kind === "permission") {
    return `role:${normalized.name}`;
  }
  if (normalized.kind === "through") {
    return `through:${normalized.roleName}->${normalized.targetPermission}`;
  }
  if (normalized.kind === "through-all") {
    return `through-all:${normalized.roleName}.all(${normalized.targetPermission})`;
  }
  if (normalized.kind === "both") {
    return `both:(${termKey(normalized.left)}&${termKey(normalized.right)})`;
  }
  if (normalized.kind === "excluding") {
    return `excluding:(${termKey(normalized.term)}-${termKey(normalized.banned)})`;
  }
  if (normalized.kind === "or") {
    return `or:(${normalized.terms.map(termKey).join("+")})`;
  }
  return `gated:(${termKey(normalized.term)}&${termKey(normalized.condition)})`;
}

function sortTerms(terms: readonly AccessIrTerm[]): AccessIrTerm[] {
  return [...terms].sort((left, right) => termKey(left).localeCompare(termKey(right)));
}

function roleMap(roles: readonly AccessIrRole[]): Map<string, AccessIrRole> {
  return new Map(roles.map((role) => [role.name, role]));
}

function permissionMap(permissions: readonly AccessIrPermission[]): Map<string, AccessIrPermission> {
  return new Map(permissions.map((permission) => [permission.name, permission]));
}

function subjectSet(subjects: readonly AccessIrSubject[]): Set<string> {
  return new Set(subjects.map(subjectKey));
}

/**
 * Semantic diff. OR-set order is ignored; exclusion and intersection
 * order are kept. Same-entity permission refs compare equal to roles of
 * the same name (SpiceDB's shared namespace).
 */
export function accessIrDiff(expected: AccessIrDefinition, actual: AccessIrDefinition): readonly string[] {
  const differences: string[] = [];
  if (expected.wireName !== actual.wireName) {
    differences.push(`wire name ${expected.wireName} vs ${actual.wireName}`);
  }

  differences.push(...roleDifferences(expected, actual));
  differences.push(...permissionDifferences(expected, actual));
  return differences;
}

function roleDifferences(expected: AccessIrDefinition, actual: AccessIrDefinition): readonly string[] {
  const differences: string[] = [];
  const expectedRoles = roleMap(expected.roles);
  const actualRoles = roleMap(actual.roles);
  for (const name of new Set([...expectedRoles.keys(), ...actualRoles.keys()])) {
    const left = expectedRoles.get(name);
    const right = actualRoles.get(name);
    if (left === undefined) {
      differences.push(`${expected.wireName} extra role ${name}`);
      continue;
    }
    if (right === undefined) {
      differences.push(`${expected.wireName} missing role ${name}`);
      continue;
    }
    differences.push(...subjectDifferences(`${expected.wireName}#${name}`, left, right));
  }
  return differences;
}

function subjectDifferences(role: string, left: AccessIrRole, right: AccessIrRole): readonly string[] {
  const leftSubjects = subjectSet(left.subjects);
  const rightSubjects = subjectSet(right.subjects);
  return [
    ...[...leftSubjects]
      .filter((subject) => !rightSubjects.has(subject))
      .map((subject) => `${role} missing subject ${subject}`),
    ...[...rightSubjects]
      .filter((subject) => !leftSubjects.has(subject))
      .map((subject) => `${role} extra subject ${subject}`),
  ];
}

function permissionDifferences(expected: AccessIrDefinition, actual: AccessIrDefinition): readonly string[] {
  const differences: string[] = [];
  const expectedPermissions = permissionMap(expected.permissions);
  const actualPermissions = permissionMap(actual.permissions);
  for (const name of new Set([...expectedPermissions.keys(), ...actualPermissions.keys()])) {
    const left = expectedPermissions.get(name);
    const right = actualPermissions.get(name);
    if (left === undefined) {
      differences.push(`${expected.wireName} extra permission ${name}`);
      continue;
    }
    if (right === undefined) {
      differences.push(`${expected.wireName} missing permission ${name}`);
      continue;
    }
    const leftKeys = sortTerms(left.terms).map(termKey).join(" | ");
    const rightKeys = sortTerms(right.terms).map(termKey).join(" | ");
    if (leftKeys !== rightKeys) {
      differences.push(`${expected.wireName}#${name} terms ${leftKeys} vs ${rightKeys}`);
    }
  }

  return differences;
}

export function accessIrDefinitionsDiff(
  expected: readonly AccessIrDefinition[],
  actual: readonly AccessIrDefinition[],
): readonly string[] {
  const expectedMap = new Map(expected.map((definition) => [definition.wireName, definition]));
  const actualMap = new Map(actual.map((definition) => [definition.wireName, definition]));
  const differences: string[] = [];
  for (const wireName of new Set([...expectedMap.keys(), ...actualMap.keys()])) {
    const left = expectedMap.get(wireName);
    const right = actualMap.get(wireName);
    if (left === undefined) {
      differences.push(`extra definition ${wireName}`);
      continue;
    }
    if (right === undefined) {
      differences.push(`missing definition ${wireName}`);
      continue;
    }
    differences.push(...accessIrDiff(left, right));
  }
  return differences;
}
