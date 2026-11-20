/**
 * What "source" means and what "a test file" means, decided in one place.
 *
 * The production ceiling and the test ceiling read the same classification, so
 * every budgeted file lands under exactly one of them: never both, and never
 * neither. The same module answers the narrower questions the other signals
 * ask — is this Rust, is this TypeScript, which package owns this path.
 */

/** Top-level directories a line budget applies to. */
export const SOURCE_ROOTS = [
  "packages/",
  "apps/",
  "crates/",
  "fixtures/",
  "scripts/",
];

/** Extensions a line budget applies to. */
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".rs", ".mjs", ".js"];

const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".test.mjs", ".test.js"];
const TYPE_SCRIPT_EXTENSIONS = [".ts", ".tsx"];
const PRODUCTION_PATH = /^(?:packages\/[^/]+\/[^/]+|apps\/[^/]+)\/src\/.+\.ts$/;
const PRODUCTION_EXCLUDED_SUFFIXES = [".test.ts", ".generated.ts"];
const PRODUCTION_EXCLUDED_SEGMENTS = ["/test-support/", "/type-tests/"];
const SOURCE_MARKER = "/src/";

/** Every budgeted file, test or not, in the order the file list gave them. */
export function budgetedSourceFiles(
  files: readonly string[],
  hasRootSourcePackage = false,
): readonly string[] {
  return files.filter(
    (path) =>
      (SOURCE_ROOTS.some((root) => path.startsWith(root)) ||
        (hasRootSourcePackage && path.startsWith("src/"))) &&
      SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)),
  );
}

/**
 * True for the files the test ceiling owns: the JavaScript and TypeScript
 * `*.test.*` convention, a Rust `tests.rs` sibling module, and the integration
 * tests Cargo picks up from a crate's `tests/` directory.
 */
export function isTestSource(path: string): boolean {
  if (TEST_SUFFIXES.some((suffix) => path.endsWith(suffix))) return true;
  if (path.endsWith("/tests.rs")) return true;
  return (
    path.startsWith("crates/") &&
    path.includes("/tests/") &&
    path.endsWith(".rs")
  );
}

/** True for Rust source. */
export function isRustSource(path: string): boolean {
  return path.endsWith(".rs");
}

/** True for a TypeScript module, test or not. */
export function isTypeScriptSource(path: string): boolean {
  return TYPE_SCRIPT_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** True for the hand-written TypeScript a package ships to its consumers. */
export function isProductionTypeScript(path: string): boolean {
  if (!PRODUCTION_PATH.test(path)) return false;
  if (PRODUCTION_EXCLUDED_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
    return false;
  }
  return !PRODUCTION_EXCLUDED_SEGMENTS.some((segment) =>
    path.includes(segment),
  );
}

/** The `packages/<group>/<name>` or `apps/<name>` a source file belongs to. */
export function packageRootOf(path: string): string {
  return path.slice(0, path.indexOf(SOURCE_MARKER));
}
