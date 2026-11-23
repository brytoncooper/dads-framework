import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import { bindingScopes, scopedImportProblem } from "./binding-dependency-scopes.mjs";

/**
 * Package boundaries, in three gates over one declaration.
 *
 * `dads.project.json` says what every package is allowed to depend on. That
 * list is only worth something if nothing can quietly disagree with it, so
 * three different surfaces are held to the same list:
 *
 * - `imports` — no production source file reaches a package the list omits.
 * - `declared-dependencies` — the list and `package.json` say the same thing.
 *   A dependency installed but undeclared is an import waiting to happen; a
 *   dependency allowed but uninstalled is a promise the package cannot keep.
 * - `public-surface` — a published `.d.ts` names no type from outside the
 *   package and its allowed dependencies. A foreign type in a public surface
 *   makes every consumer depend on something they never chose.
 *
 * `devDependencies` are outside all of this: they are the repository's build
 * and test tools, not the package's edges.
 */

const PROJECT_FILE = "dads.project.json";
const GATES = Object.freeze({
  imports: "imports",
  declared: "declared-dependencies",
  surface: "public-surface",
});

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

/**
 * Runs every gate over every declared package.
 *
 * `world` is the only seam onto the filesystem: `exists(path)`, `read(path)`,
 * and `listFiles(directory)`, all repository-relative, so a test builds its
 * input in memory.
 */
export function checkDependencyBoundaries(world) {
  const project = JSON.parse(world.read(PROJECT_FILE));
  const packages = project.packages ?? [];
  const manifests = readManifests(packages, world);
  const workspaceNames = new Set([...manifests.values()].map((entry) => entry.manifest.name));

  const bindings = new Map(
    packages.flatMap((declared) => {
      const manifest = manifests.get(declared.name)?.manifest;
      if (manifest?.dadsBindings === undefined) return [];
      return [[manifest.name, bindingScopes(manifest, declared, world)]];
    }),
  );
  const violations = [];
  const skippedSurfaces = [];
  for (const declared of packages) {
    const allowed = new Set(declared.allowedDependencies ?? []);
    violations.push(...checkImports(declared, allowed, world, bindings));

    const entry = manifests.get(declared.name);
    if (entry === undefined) continue;
    violations.push(...checkDeclaredDependencies(declared, allowed, entry, workspaceNames));

    if (entry.manifest.publishConfig === undefined) continue;
    const surface = checkPublicSurface(declared, allowed, entry, world);
    violations.push(...surface.violations);
    if (surface.skipped) skippedSurfaces.push(declared.name);
  }
  return { violations, skippedSurfaces, checkedPackages: packages.length };
}

/** Every production source file of a package reaches only allowed packages. */
function checkImports(declared, allowed, world, bindings) {
  const violations = [];
  for (const file of world.listFiles(`${declared.root}/src`)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    for (const dependency of readModuleSpecifiers(world.read(file), file)) {
      const name = packageOf(dependency);
      const scopedProblem = scopedImportProblem({
        file,
        specifier: dependency,
        owner: declared.name,
        module: name,
        bindings,
        kind: declared.kind,
      });
      if (scopedProblem !== undefined) {
        violations.push(violation(GATES.imports, declared, file, name, scopedProblem));
        continue;
      }
      if (isLocalSpecifier(dependency)) continue;
      if (allowed.has(name)) continue;
      violations.push(violation(GATES.imports, declared, file, name, `imports "${name}"`));
    }
  }
  return violations;
}

/** The allowed list and the manifest name the same edges, in both directions. */
function checkDeclaredDependencies(declared, allowed, entry, workspaceNames) {
  const violations = [];
  const installed = new Set();
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const name of Object.keys(entry.manifest[field] ?? {})) {
      installed.add(name);
      if (allowed.has(name)) continue;
      violations.push(
        violation(GATES.declared, declared, entry.path, name, `declares "${name}" in ${field} but does not allow it`),
      );
    }
  }
  for (const name of allowed) {
    if (workspaceNames.has(name) || installed.has(name)) continue;
    violations.push(
      violation(
        GATES.declared,
        declared,
        entry.path,
        name,
        `allows "${name}" but does not declare it in dependencies, optionalDependencies, or peerDependencies`,
      ),
    );
  }
  return violations;
}

/**
 * The emitted type surface names nothing foreign.
 *
 * The surface is `dist/index.d.ts` plus the `.d.ts` of every `exports`
 * subpath. When none of them are on disk the package has not been built, and
 * an unbuilt package is not a violation — the gate says it skipped.
 */
function checkPublicSurface(declared, allowed, entry, world) {
  const violations = [];
  let checked = 0;
  for (const file of surfaceFiles(declared.root, entry.manifest)) {
    if (!world.exists(file)) continue;
    checked += 1;
    for (const specifier of readModuleSpecifiers(world.read(file), file)) {
      if (isLocalSpecifier(specifier)) continue;
      const name = packageOf(specifier);
      if (name === entry.manifest.name || allowed.has(name)) continue;
      violations.push(
        violation(
          GATES.surface,
          declared,
          file,
          name,
          `exposes "${specifier}", which is neither the package itself nor an allowed dependency`,
        ),
      );
    }
  }
  return { violations, skipped: checked === 0 };
}

// ---------------------------------------------------------------------------
// Reading the declaration and the sources
// ---------------------------------------------------------------------------

function readManifests(packages, world) {
  const manifests = new Map();
  for (const declared of packages) {
    const path = `${declared.root}/package.json`;
    if (!world.exists(path)) continue;
    const manifest = JSON.parse(world.read(path));
    manifests.set(declared.name, { path, manifest });
  }
  return manifests;
}

/** `dist/index.d.ts` and every `.d.ts` an `exports` condition points at. */
function surfaceFiles(root, manifest) {
  const files = new Set([`${root}/dist/index.d.ts`]);
  const collect = (target) => {
    if (typeof target === "string") {
      if (target.endsWith(".d.ts")) {
        files.add(`${root}/${target.replace(/^\.\//u, "")}`);
      }
      return;
    }
    if (target === null || typeof target !== "object") return;
    for (const nested of Object.values(target)) collect(nested);
  };
  collect(manifest.exports);
  return [...files].sort();
}

/**
 * Every module specifier a file names: `import`, `export … from`, and the
 * dynamic imports, and `import("…")` types in emitted declarations.
 */
function readModuleSpecifiers(source, path) {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = new Set();
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      specifiers.add(node.argument.literal.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

/** A relative path or a Node builtin is never a package edge. */
function isLocalSpecifier(specifier) {
  return specifier.startsWith(".") || specifier.startsWith("node:");
}

/** `@scope/name/deep` and `name/deep` both name the package `…/name`. */
function packageOf(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function violation(gate, declared, file, dependency, detail) {
  return {
    gate,
    package: declared.name,
    file,
    dependency,
    message: `${declared.name} ${detail} (${file})`,
  };
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/** JSON for machines, one line per finding for people. */
export function render(result, asJson) {
  const ok = result.violations.length === 0;
  if (asJson) {
    const payload = {
      ok,
      violations: result.violations,
      checkedPackages: result.checkedPackages,
      skippedSurfaces: result.skippedSurfaces,
    };
    return `${JSON.stringify(payload)}\n`;
  }

  const lines = result.violations.map((finding) => `${finding.gate}: ${finding.message}`);
  if (result.skippedSurfaces.length > 0) {
    const skipped = result.skippedSurfaces.join(", ");
    lines.push(`${GATES.surface}: skipped (no dist) — ${skipped}`);
  }
  lines.push(
    ok
      ? `dependency boundaries: ok — ${result.checkedPackages} packages`
      : `dependency boundaries: ${countLabel(result.violations.length)}`,
  );
  return `${lines.join("\n")}\n`;
}

function countLabel(count) {
  return `${count} ${count === 1 ? "violation" : "violations"}`;
}

/** The filesystem behind `world`, rooted at the repository. */
export function createDiskWorld(root) {
  return {
    exists: (path) => existsSync(join(root, path)),
    read: (path) => readFileSync(join(root, path), "utf8"),
    listFiles: (directory) => listFilesUnder(root, directory),
  };
}

function listFilesUnder(root, directory) {
  const files = [];
  const visit = (relativeDirectory) => {
    let entries;
    try {
      entries = readdirSync(join(root, relativeDirectory), {
        withFileTypes: true,
      });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const path = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(directory);
  return files.sort();
}

function resolveRoot(argv) {
  const index = argv.indexOf("--root");
  return index === -1 || argv[index + 1] === undefined ? process.cwd() : resolve(argv[index + 1]);
}

export function main(argv) {
  const result = checkDependencyBoundaries(createDiskWorld(resolveRoot(argv)));
  return {
    exitCode: result.violations.length > 0 ? 1 : 0,
    output: render(result, argv.includes("--json")),
  };
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const result = main(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}
