import type { AccessIrDefinition } from "./ir.js";
import { emitErgonomicTypeScript } from "./emit-typescript-ergonomic.js";
import { parseZed } from "./parse-zed.js";

/**
 * Compile access IR definitions into strict, zero-`any` Dads TypeScript using
 * `actor`, `resource`, and `compileAccess`.
 */
export function emitTypeScript(definitions: readonly AccessIrDefinition[]): string {
  return emitErgonomicTypeScript(definitions);
}

/**
 * Parse SpiceDB `.zed` schema text and emit equivalent Dads TypeScript.
 */
export function emitTypeScriptFromZed(zed: string): string {
  return emitTypeScript(parseZed(zed));
}
