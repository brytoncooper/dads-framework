import { compileAccessFromIr, type AccessIrDefinition, type AccessModel } from "@dads-framework/access";

/**
 * Reconstruct an in-memory `AccessModel` from parsed SpiceDB IR definitions
 * so `PostgresAuthorization` can evaluate permissions directly after a live
 * SpiceDB migration without executing generated TypeScript.
 */
export function buildAccessModelFromIr(definitions: readonly AccessIrDefinition[]): AccessModel {
  return compileAccessFromIr(definitions);
}
