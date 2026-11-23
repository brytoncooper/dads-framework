import { createHash } from "node:crypto";

/** Computes the SHA-256 hex digest of an opaque invitation token. */
export function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
