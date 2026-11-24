/**
 * Drop-in zero-Nx ESLint rule replacing `@nx/eslint-plugin`'s
 * `enforce-module-boundaries` rule.
 */
import { builtinModules } from "node:module";
import { dirname, posix, relative, resolve } from "node:path";
import { isRecord } from "../parse-guards.js";
import {
  findBoundaryWorkspaceRoot,
  getCachedWorkspaceBoundaryIndex,
  type BoundaryProject,
  type WorkspaceBoundaryIndex,
} from "./workspace-index.js";

const nodeBuiltins = new Set<string>([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const ignoredSpecifierPrefixes: readonly string[] = ["virtual:", "data:", "http:", "https:"];

export type DepConstraint = {
  readonly sourceTag: string;
  readonly onlyDependOnLibsWithTags?: readonly string[];
  readonly notDependOnLibsWithTags?: readonly string[];
  readonly bannedExternalImports?: readonly string[];
};

export type ModuleBoundariesOptions = {
  readonly enforceBuildableLibDependency?: boolean;
  readonly banTransitiveDependencies?: boolean;
  readonly allow?: readonly string[];
  readonly depConstraints?: readonly DepConstraint[];
};

export type EslintReportDescriptor = {
  readonly node: unknown;
  readonly messageId: string;
  readonly data?: Readonly<Record<string, string>>;
};

export type EslintRuleContext = {
  readonly options: readonly unknown[];
  readonly filename?: string;
  readonly getFilename?: () => string;
  readonly report: (descriptor: EslintReportDescriptor) => void;
};

export type EslintRuleListener = Readonly<Record<string, (node: unknown) => void>>;

export type EslintRuleDefinition = {
  readonly meta: Readonly<Record<string, unknown>>;
  readonly create: (context: EslintRuleContext) => EslintRuleListener;
};

export type EslintBoundaryPlugin = {
  readonly rules: {
    readonly "enforce-module-boundaries": EslintRuleDefinition;
  };
};

type ParsedRuleOptions = {
  readonly enforceBuildableLib: boolean;
  readonly banTransitive: boolean;
  readonly allow: readonly string[];
  readonly depConstraints: readonly DepConstraint[];
};

type CheckContext = {
  readonly context: EslintRuleContext;
  readonly index: WorkspaceBoundaryIndex;
  readonly absFilename: string;
  readonly relFilename: string;
  readonly sourceProject: BoundaryProject;
  readonly matchingConstraints: readonly DepConstraint[];
  readonly options: ParsedRuleOptions;
};

const ruleMessages = {
  noRelativeCrossProject:
    'Projects cannot import from another project ("{{target}}") via relative path "{{specifier}}". Import through the public path alias instead.',
  tagConstraint:
    'A project tagged with "{{sourceTag}}" can only depend on libs tagged with {{allowedTags}} (imported "{{target}}" via "{{specifier}}").',
  notTagConstraint:
    'A project tagged with "{{sourceTag}}" cannot depend on libs tagged with {{bannedTags}} (imported "{{target}}" via "{{specifier}}").',
  bannedExternal:
    'A project tagged with "{{sourceTag}}" cannot import external package "{{specifier}}" (matches bannedExternalImports "{{pattern}}").',
  transitiveDependency:
    'Projects cannot import transitive dependency "{{pkg}}" (via "{{specifier}}"). Declare it in package.json.',
  buildableLibDependency:
    'Buildable library "{{source}}" cannot import non-buildable library "{{target}}" (via "{{specifier}}").',
  circularDependency: 'Circular dependency between "{{source}}" and "{{target}}" detected (via "{{specifier}}").',
};

const ruleSchema = [
  {
    type: "object",
    properties: {
      enforceBuildableLibDependency: { type: "boolean" },
      banTransitiveDependencies: { type: "boolean" },
      allow: { type: "array", items: { type: "string" } },
      depConstraints: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sourceTag: { type: "string" },
            onlyDependOnLibsWithTags: { type: "array", items: { type: "string" } },
            notDependOnLibsWithTags: { type: "array", items: { type: "string" } },
            bannedExternalImports: { type: "array", items: { type: "string" } },
          },
          additionalProperties: true,
        },
      },
    },
    additionalProperties: true,
  },
];

/** Extracts the npm package name (scoped or unscoped) from a bare import specifier. */
export function extractBoundaryPackageName(specifier: string): string {
  const clean = specifier.split("?")[0] ?? specifier;
  if (clean.startsWith("@")) {
    const parts = clean.split("/");
    return parts.length >= 2 ? `${parts[0] ?? ""}/${parts[1] ?? ""}` : clean;
  }
  return clean.split("/")[0] ?? clean;
}

/** Creates the `enforce-module-boundaries` ESLint rule, optionally pinned to a preloaded workspace index. */
export function createEnforceModuleBoundariesRule(overrideIndex?: WorkspaceBoundaryIndex): EslintRuleDefinition {
  return {
    meta: {
      type: "problem",
      docs: { description: "Enforce workspace project tag dependency constraints and external import bans." },
      schema: ruleSchema,
      messages: ruleMessages,
    },
    create(context) {
      const checkCtx = buildCheckContext(context, overrideIndex);
      if (checkCtx === undefined) return {};
      return createAstVisitors(checkCtx);
    },
  };
}

/** Default ESLint flat-config plugin exporting `rules["enforce-module-boundaries"]`. */
export const enforceModuleBoundariesPlugin: EslintBoundaryPlugin = {
  rules: {
    "enforce-module-boundaries": createEnforceModuleBoundariesRule(),
  },
};

function buildCheckContext(
  context: EslintRuleContext,
  overrideIndex: WorkspaceBoundaryIndex | undefined,
): CheckContext | undefined {
  const filename = context.filename ?? context.getFilename?.();
  if (filename === undefined || filename.length === 0 || filename === "<input>") return undefined;
  const absFilename = resolve(filename);
  const index = overrideIndex ?? getCachedWorkspaceBoundaryIndex(findBoundaryWorkspaceRoot(dirname(absFilename)));
  const relFilename = relative(index.workspaceRoot, absFilename).replaceAll("\\", "/");
  if (relFilename.startsWith("..")) return undefined;
  const sourceProject = index.findProjectForRelPath(relFilename);
  if (sourceProject === undefined) return undefined;
  const options = parseRuleOptions(context.options[0]);
  const matchingConstraints = options.depConstraints.filter(
    (c) => c.sourceTag === "*" || sourceProject.tags.includes(c.sourceTag),
  );
  return { context, index, absFilename, relFilename, sourceProject, matchingConstraints, options };
}

function parseRuleOptions(raw: unknown): ParsedRuleOptions {
  if (!isRecord(raw)) {
    return { enforceBuildableLib: false, banTransitive: false, allow: [], depConstraints: [] };
  }
  const allow = readBoundaryStrings(raw["allow"]);
  const depConstraints = readDepConstraints(raw["depConstraints"]);
  return {
    enforceBuildableLib: raw["enforceBuildableLibDependency"] === true,
    banTransitive: raw["banTransitiveDependencies"] === true,
    allow,
    depConstraints,
  };
}

function readDepConstraints(raw: unknown): readonly DepConstraint[] {
  if (!Array.isArray(raw)) return [];
  const list: DepConstraint[] = [];
  for (const item of raw) {
    const parsed = parseOneDepConstraint(item);
    if (parsed !== undefined) list.push(parsed);
  }
  return list;
}

function parseOneDepConstraint(item: unknown): DepConstraint | undefined {
  if (!isRecord(item) || typeof item["sourceTag"] !== "string") return undefined;
  const onlyTags = readOptionalBoundaryStrings(item["onlyDependOnLibsWithTags"]);
  const notTags = readOptionalBoundaryStrings(item["notDependOnLibsWithTags"]);
  const banned = readOptionalBoundaryStrings(item["bannedExternalImports"]);
  return {
    sourceTag: item["sourceTag"],
    ...(onlyTags === undefined ? {} : { onlyDependOnLibsWithTags: onlyTags }),
    ...(notTags === undefined ? {} : { notDependOnLibsWithTags: notTags }),
    ...(banned === undefined ? {} : { bannedExternalImports: banned }),
  };
}

function readOptionalBoundaryStrings(raw: unknown): readonly string[] | undefined {
  return Array.isArray(raw) ? readBoundaryStrings(raw) : undefined;
}

function readBoundaryStrings(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

function createAstVisitors(checkCtx: CheckContext): EslintRuleListener {
  const inspectSource = (node: unknown): void => {
    if (!isRecord(node) || !isRecord(node["source"])) return;
    const value = node["source"]["value"];
    if (typeof value === "string") checkImportSpecifier(checkCtx, node["source"], value);
  };
  return {
    ImportDeclaration: inspectSource,
    ExportNamedDeclaration: inspectSource,
    ExportAllDeclaration: inspectSource,
    ImportExpression: (node) => {
      if (!isRecord(node) || !isRecord(node["source"])) return;
      if (node["source"]["type"] === "Literal" && typeof node["source"]["value"] === "string") {
        checkImportSpecifier(checkCtx, node["source"], node["source"]["value"]);
      }
    },
    CallExpression: (node) => {
      const arg = extractRequireLiteralArg(node);
      if (arg !== undefined) checkImportSpecifier(checkCtx, arg.node, arg.value);
    },
    TSImportType: (node) => {
      const arg = extractTsImportTypeLiteral(node);
      if (arg !== undefined) checkImportSpecifier(checkCtx, arg.node, arg.value);
    },
    TSImportEqualsDeclaration: (node) => {
      const arg = extractTsImportEqualsLiteral(node);
      if (arg !== undefined) checkImportSpecifier(checkCtx, arg.node, arg.value);
    },
  };
}

function extractTsImportTypeLiteral(node: unknown): { readonly node: unknown; readonly value: string } | undefined {
  if (!isRecord(node)) return undefined;
  // typescript-eslint v8 uses `source` (Literal); v7 uses `argument` (TSLiteralType -> literal).
  const candidate = node["source"] ?? node["argument"];
  if (!isRecord(candidate)) return undefined;
  if (candidate["type"] === "Literal" && typeof candidate["value"] === "string") {
    return { node: candidate, value: candidate["value"] };
  }
  if (
    candidate["type"] === "TSLiteralType" &&
    isRecord(candidate["literal"]) &&
    candidate["literal"]["type"] === "Literal" &&
    typeof candidate["literal"]["value"] === "string"
  ) {
    return { node: candidate["literal"], value: candidate["literal"]["value"] };
  }
  return undefined;
}

function extractTsImportEqualsLiteral(node: unknown): { readonly node: unknown; readonly value: string } | undefined {
  if (!isRecord(node) || !isRecord(node["moduleReference"])) return undefined;
  const ref = node["moduleReference"];
  if (ref["type"] !== "TSExternalModuleReference" || !isRecord(ref["expression"])) return undefined;
  if (ref["expression"]["type"] === "Literal" && typeof ref["expression"]["value"] === "string") {
    return { node: ref["expression"], value: ref["expression"]["value"] };
  }
  return undefined;
}

function extractRequireLiteralArg(node: unknown): { readonly node: unknown; readonly value: string } | undefined {
  if (!isRecord(node) || !isRecord(node["callee"]) || !Array.isArray(node["arguments"])) return undefined;
  if (node["callee"]["type"] !== "Identifier" || node["callee"]["name"] !== "require") return undefined;
  if (node["arguments"].length !== 1) return undefined;
  const first: unknown = node["arguments"][0];
  if (!isRecord(first) || first["type"] !== "Literal" || typeof first["value"] !== "string") return undefined;
  return { node: first, value: first["value"] };
}

function checkImportSpecifier(checkCtx: CheckContext, node: unknown, rawSpecifier: string): void {
  if (rawSpecifier.length === 0 || matchesBoundaryAllow(rawSpecifier, checkCtx.options.allow)) return;
  const specifier = rawSpecifier.split("?")[0] ?? rawSpecifier;
  if (ignoredSpecifierPrefixes.some((p) => specifier.startsWith(p))) return;
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    checkRelativeImport(checkCtx, node, specifier, rawSpecifier);
    return;
  }
  const aliasTarget = checkCtx.index.resolveAliasTarget(specifier);
  if (aliasTarget !== undefined) {
    if (aliasTarget.name !== checkCtx.sourceProject.name) {
      checkProjectConstraints(checkCtx, node, aliasTarget, rawSpecifier);
    }
    return;
  }
  checkExternalImport(checkCtx, node, specifier, rawSpecifier);
}

function checkRelativeImport(checkCtx: CheckContext, node: unknown, specifier: string, rawSpecifier: string): void {
  if (specifier.startsWith("/")) return;
  const resolvedRel = posix.normalize(posix.join(posix.dirname(checkCtx.relFilename), specifier));
  const targetProject = checkCtx.index.findProjectForRelPath(resolvedRel);
  if (targetProject === undefined || targetProject.name === checkCtx.sourceProject.name || targetProject.root === ".") {
    return;
  }
  checkCtx.context.report({
    node,
    messageId: "noRelativeCrossProject",
    data: { target: targetProject.name, specifier: rawSpecifier },
  });
  checkProjectConstraints(checkCtx, node, targetProject, rawSpecifier);
}

function checkExternalImport(checkCtx: CheckContext, node: unknown, specifier: string, rawSpecifier: string): void {
  const pkgName = extractBoundaryPackageName(specifier);
  if (specifier.startsWith("node:") || nodeBuiltins.has(specifier) || nodeBuiltins.has(pkgName)) return;
  for (const constraint of checkCtx.matchingConstraints) {
    reportBannedExternals(checkCtx.context, node, constraint, specifier, pkgName, rawSpecifier);
  }
  if (checkCtx.options.banTransitive && !checkCtx.index.isDeclaredForFile(checkCtx.absFilename, pkgName)) {
    checkCtx.context.report({
      node,
      messageId: "transitiveDependency",
      data: { pkg: pkgName, specifier: rawSpecifier },
    });
  }
}

function reportBannedExternals(
  context: EslintRuleContext,
  node: unknown,
  constraint: DepConstraint,
  specifier: string,
  pkgName: string,
  rawSpecifier: string,
): void {
  for (const pattern of constraint.bannedExternalImports ?? []) {
    if (matchesBannedExternalPattern(specifier, pkgName, pattern)) {
      context.report({
        node,
        messageId: "bannedExternal",
        data: { sourceTag: constraint.sourceTag, specifier: rawSpecifier, pattern },
      });
    }
  }
}

function checkProjectConstraints(
  checkCtx: CheckContext,
  node: unknown,
  targetProject: BoundaryProject,
  rawSpecifier: string,
): void {
  const { context, index, sourceProject, options } = checkCtx;
  if (
    options.enforceBuildableLib &&
    sourceProject.projectType === "library" &&
    sourceProject.isBuildable &&
    targetProject.projectType === "library" &&
    !targetProject.isBuildable
  ) {
    context.report({
      node,
      messageId: "buildableLibDependency",
      data: { source: sourceProject.name, target: targetProject.name, specifier: rawSpecifier },
    });
  }
  if (index.hasDependencyPath(targetProject.name, sourceProject.name)) {
    context.report({
      node,
      messageId: "circularDependency",
      data: { source: sourceProject.name, target: targetProject.name, specifier: rawSpecifier },
    });
  }
  for (const constraint of checkCtx.matchingConstraints) {
    reportTagConstraintViolations(context, node, constraint, targetProject, rawSpecifier);
  }
}

function reportTagConstraintViolations(
  context: EslintRuleContext,
  node: unknown,
  constraint: DepConstraint,
  targetProject: BoundaryProject,
  rawSpecifier: string,
): void {
  if (
    constraint.onlyDependOnLibsWithTags !== undefined &&
    !matchesAnyProjectTag(targetProject.tags, constraint.onlyDependOnLibsWithTags)
  ) {
    context.report({
      node,
      messageId: "tagConstraint",
      data: {
        sourceTag: constraint.sourceTag,
        allowedTags: constraint.onlyDependOnLibsWithTags.map((t) => `"${t}"`).join(", "),
        target: targetProject.name,
        specifier: rawSpecifier,
      },
    });
  }
  if (
    constraint.notDependOnLibsWithTags !== undefined &&
    matchesAnyProjectTag(targetProject.tags, constraint.notDependOnLibsWithTags)
  ) {
    context.report({
      node,
      messageId: "notTagConstraint",
      data: {
        sourceTag: constraint.sourceTag,
        bannedTags: constraint.notDependOnLibsWithTags.map((t) => `"${t}"`).join(", "),
        target: targetProject.name,
        specifier: rawSpecifier,
      },
    });
  }
}

function matchesBannedExternalPattern(specifier: string, pkgName: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return specifier.startsWith(prefix) || pkgName.startsWith(prefix);
  }
  return specifier === pattern || specifier.startsWith(`${pattern}/`) || pkgName === pattern;
}

function matchesBoundaryAllow(specifier: string, allowList: readonly string[]): boolean {
  return allowList.some((pattern) =>
    pattern.endsWith("*") ? specifier.startsWith(pattern.slice(0, -1)) : specifier === pattern,
  );
}

function matchesAnyProjectTag(projectTags: readonly string[], allowedTags: readonly string[]): boolean {
  return allowedTags.includes("*") || allowedTags.some((tag) => projectTags.includes(tag));
}
