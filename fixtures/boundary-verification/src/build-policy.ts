import { emitZedForDefinitions } from "@dads-framework/access";
import { boundaryVerificationModel } from "./access.js";

export function buildBoundaryVerificationPolicy(): string {
  return JSON.stringify(emitZedForDefinitions(boundaryVerificationModel));
}
