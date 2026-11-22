import type { AccessModel } from "./access-model.js";
import { emitAccessIr } from "./emit-ir.js";
import { GENERATED_ZED_HEADER } from "./generated-header.js";
import type {
  AccessIrDefinition,
  AccessIrRole,
  AccessIrSubject,
  AccessIrTerm,
} from "./ir.js";

function baseSubjectText(subject: AccessIrSubject): string {
  if (subject.kind === "type") {
    return subject.wireName;
  }
  if (subject.kind === "wildcard") {
    return `${subject.wireName}:*`;
  }
  return `${subject.wireName}#${subject.relation}`;
}

function subjectText(subject: AccessIrSubject): string {
  const base = baseSubjectText(subject);
  return subject.expiration === true ? `${base} with expiration` : base;
}

function termText(term: AccessIrTerm): string {
  if (term.kind === "role" || term.kind === "permission") {
    return term.name;
  }
  if (term.kind === "through") {
    return `${term.roleName}->${term.targetPermission}`;
  }
  if (term.kind === "through-all") {
    return `${term.roleName}.all(${term.targetPermission})`;
  }
  if (term.kind === "or") {
    return unionText(term.terms);
  }
  if (term.kind === "gated") {
    return `((${termText(term.term)}) & (${termText(term.condition)}))`;
  }
  if (term.kind === "excluding") {
    return `(${termText(term.term)}) - (${termText(term.banned)})`;
  }
  return `((${termText(term.left)}) & (${termText(term.right)}))`;
}

/**
 * Terms joined by `+`. SpiceDB does not stop `-` at the next `+`, so an
 * exclusion beside other arms (`a + (b) - (c) + d`) would subtract `c + d`
 * from everything before it; it is wrapped as one arm. A lone exclusion is the
 * whole expression and keeps its text.
 */
function unionText(terms: readonly AccessIrTerm[]): string {
  if (terms.length === 1) {
    return terms.map(termText).join("");
  }
  return terms
    .map((term) =>
      term.kind === "excluding" ? `(${termText(term)})` : termText(term),
    )
    .join(" + ");
}

function emitDefinition(definition: AccessIrDefinition): string {
  if (definition.roles.length === 0 && definition.permissions.length === 0) {
    return `definition ${definition.wireName} {}`;
  }
  const lines = [`definition ${definition.wireName} {`];
  for (const role of definition.roles) {
    lines.push(
      `  relation ${role.name}: ${role.subjects.map(subjectText).join(" | ")}`,
    );
  }
  if (definition.roles.length > 0 && definition.permissions.length > 0) {
    lines.push("");
  }
  for (const permission of definition.permissions) {
    lines.push(
      `  permission ${permission.name} = ${unionText(permission.terms)}`,
    );
  }
  lines.push("}");
  return lines.join("\n");
}

/**
 * SpiceDB schema text for the model’s `access()` definitions, in composition
 * order. Always starts with the generated-file header.
 */
export function emitZed(model: AccessModel): string {
  const definitions = emitAccessIr(model);
  return joinZedDocument(definitions);
}

export function emitZedForDefinitions(
  definitions: readonly AccessIrDefinition[],
): string {
  return joinZedDocument(definitions);
}

function roleUsesExpiration(role: AccessIrRole): boolean {
  return role.subjects.some((subject) => subject.expiration === true);
}

function usesExpiration(definitions: readonly AccessIrDefinition[]): boolean {
  return definitions.some((definition) =>
    definition.roles.some(roleUsesExpiration),
  );
}

function joinZedDocument(definitions: readonly AccessIrDefinition[]): string {
  const bodies = definitions.map(emitDefinition);
  const pragma = usesExpiration(definitions) ? "use expiration\n\n" : "";
  return `${GENERATED_ZED_HEADER}\n\n${pragma}${bodies.join("\n\n")}\n`;
}
