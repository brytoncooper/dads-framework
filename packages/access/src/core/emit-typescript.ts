import type { AccessIrDefinition } from "./ir.js";
import { emitClassicTypeScript } from "./emit-typescript-classic.js";
import { emitErgonomicTypeScript } from "./emit-typescript-ergonomic.js";
import { parseZed } from "./parse-zed.js";

export type EmitTypeScriptStyle = "ergonomic" | "classic";

export type EmitTypeScriptOptions = {
  readonly style?: EmitTypeScriptStyle;
};

/**
 * Compile access IR definitions into strict, zero-`any` Dads TypeScript.
 * Defaults to the ergonomic DSL (`actor`, `resource`, `compileAccess`);
 * pass `{ style: "classic" }` for `entityHandle`, `access`, and `accessModel`.
 */
export function emitTypeScript(
  definitions: readonly AccessIrDefinition[],
  options?: EmitTypeScriptOptions,
): string {
  if (options?.style === "classic") {
    return emitClassicTypeScript(definitions);
  }
  return emitErgonomicTypeScript(definitions);
}

/**
 * Parse SpiceDB `.zed` schema text and emit equivalent Dads TypeScript.
 */
export function emitTypeScriptFromZed(
  zed: string,
  options?: EmitTypeScriptOptions,
): string {
  return emitTypeScript(parseZed(zed), options);
}
