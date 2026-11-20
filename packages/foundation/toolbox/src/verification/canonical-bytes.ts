/**
 * The three primitives a reproducible verification identity is built from:
 * one text encoding, one ordering, one digest. Capture and identity both
 * depend on them, and both must agree byte for byte, so they live in one place
 * rather than being restated per module.
 */
import { createHash } from "node:crypto";

/** Byte-order text comparison, so a sorted list never depends on a locale. */
export function compareText(firstValue: string, secondValue: string): number {
  if (firstValue < secondValue) return -1;
  if (firstValue > secondValue) return 1;
  return 0;
}

/** The one serialization used for comparing and hashing captured values. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

export function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}
