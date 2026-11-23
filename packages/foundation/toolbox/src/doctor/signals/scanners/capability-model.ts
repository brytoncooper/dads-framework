/**
 * Capabilities, their implementers, and their consumers.
 *
 * Two signals ask about the same object and would answer differently if each
 * built its own model of it: `single-implementer-abstractions` asks whether an
 * abstraction was ever needed, and `no-in-memory-provider` asks whether the
 * boundary it announces can be stood in for. Both need the same three facts,
 * so the model is built here once.
 *
 * A **capability** is an exported type whose members are all behaviour: a type
 * or an interface every member of which is a method or a function-valued
 * property. That is the shape a port takes — `read`, `write`, `check` — and it
 * is what distinguishes a contract somebody must implement from a record shape
 * somebody must fill in.
 *
 * An **implementer** is a value in *another* module that claims to be one: a
 * declaration annotated with the capability, a class that implements it, or a
 * function that returns it, which is how a provider is usually built. It has
 * to be another module, because a type declared beside the one factory that
 * returns it is that factory's return shape rather than a contract anybody
 * could implement differently. A **consumer** is another module that imports
 * the name without implementing it: a module imports the capability to say it
 * is one, and that is not the same as depending on one.
 *
 * This is a syntactic model and it says so. A value that satisfies the
 * capability structurally without ever naming it is not counted, because
 * nothing in the source says it was meant to.
 */

import type { SignalEvidence } from "../../doctor-signal.js";
import {
  evidenceAt,
  exportedStatements,
  importedBindings,
  leftmostTypeName,
  ts,
  visitNodes,
  type DoctorModule,
  type DoctorProgram,
} from "./typescript-program.js";

/** One named contract and the values that answer to it. */
export type Capability = {
  readonly name: string;
  readonly declaredIn: string;
  readonly evidence: SignalEvidence;
  readonly implementers: readonly SignalEvidence[];
  readonly consumers: readonly string[];
};

type Declaration = {
  readonly name: string;
  readonly declaredIn: string;
  readonly evidence: SignalEvidence;
};

/** One implementer, and the module it was found in. */
type Implementation = {
  readonly foundIn: string;
  readonly evidence: SignalEvidence;
};

function isBehaviour(member: ts.TypeElement): boolean {
  if (ts.isMethodSignature(member)) return true;
  if (!ts.isPropertySignature(member)) return false;
  const type = member.type;
  return type !== undefined && ts.isFunctionTypeNode(type);
}

/** True for a type every member of which is behaviour, and there is one. */
function isCapabilityShape(members: readonly ts.TypeElement[]): boolean {
  return members.length > 0 && members.every(isBehaviour);
}

function capabilityName(statement: ts.Statement): string | undefined {
  if (ts.isInterfaceDeclaration(statement)) {
    return isCapabilityShape([...statement.members]) ? statement.name.text : undefined;
  }
  if (!ts.isTypeAliasDeclaration(statement)) return undefined;
  if (!ts.isTypeLiteralNode(statement.type)) return undefined;
  return isCapabilityShape([...statement.type.members]) ? statement.name.text : undefined;
}

function declarationsIn(module: DoctorModule): readonly Declaration[] {
  const found: Declaration[] = [];
  for (const statement of exportedStatements(module)) {
    const name = capabilityName(statement);
    if (name === undefined) continue;
    found.push({
      name,
      declaredIn: module.path,
      evidence: evidenceAt(module, statement, name),
    });
  }
  return found;
}

/** The capability name a node claims to implement, when it claims one. */
function claimedName(node: ts.Node): string | undefined {
  if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
    return node.type !== undefined && ts.isTypeReferenceNode(node.type)
      ? leftmostTypeName(node.type.typeName)
      : undefined;
  }
  if (ts.isFunctionDeclaration(node)) {
    return node.type !== undefined && ts.isTypeReferenceNode(node.type)
      ? leftmostTypeName(node.type.typeName)
      : undefined;
  }
  return undefined;
}

function implementedByClass(node: ts.Node): readonly string[] {
  if (!ts.isClassDeclaration(node)) return [];
  const names: string[] = [];
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
    for (const entry of clause.types) {
      if (ts.isIdentifier(entry.expression)) names.push(entry.expression.text);
    }
  }
  return names;
}

function declaredValueName(node: ts.Node): string {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name !== undefined) {
    return node.name.text;
  }
  return "anonymous";
}

function recordImplementers(
  module: DoctorModule,
  known: ReadonlySet<string>,
  implementers: Map<string, Implementation[]>,
): void {
  visitNodes(module.source, (node) => {
    const claimed = claimedName(node);
    const names = [...(claimed === undefined ? [] : [claimed]), ...implementedByClass(node)].filter((name) =>
      known.has(name),
    );
    for (const name of names) {
      const found = implementers.get(name) ?? [];
      found.push({
        foundIn: module.path,
        evidence: evidenceAt(module, node, declaredValueName(node)),
      });
      implementers.set(name, found);
    }
  });
}

/** Every capability the workspace declares, with who answers to it. */
export function readCapabilities(program: DoctorProgram): readonly Capability[] {
  const declarations = program.modules.flatMap(declarationsIn);
  const known = new Set(declarations.map((declared) => declared.name));
  if (known.size === 0) return [];

  const implementers = new Map<string, Implementation[]>();
  const consumers = new Map<string, string[]>();
  for (const module of program.modules) {
    recordImplementers(module, known, implementers);
    for (const [name] of importedBindings(module)) {
      if (!known.has(name)) continue;
      consumers.set(name, [...(consumers.get(name) ?? []), module.path]);
    }
  }

  return declarations.map((declared) =>
    assemble(declared, implementers.get(declared.name) ?? [], consumers.get(declared.name) ?? []),
  );
}

function assemble(declared: Declaration, found: readonly Implementation[], importers: readonly string[]): Capability {
  const implementing = found.filter((implementation) => implementation.foundIn !== declared.declaredIn);
  const implementers = new Set(implementing.map((implementation) => implementation.foundIn));
  return {
    name: declared.name,
    declaredIn: declared.declaredIn,
    evidence: declared.evidence,
    implementers: implementing.map((implementation) => implementation.evidence),
    consumers: importers.filter((path) => !implementers.has(path)),
  };
}
