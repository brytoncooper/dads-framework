/**
 * Deterministic UUID v7s for factories (docs/testing/seeders.md) — no unseeded
 * randomness. Same (namespace, counter) always yields the same id, so test
 * failures reproduce and fixtures stay stable. Version nibble is 7 so rows
 * parse under `z.uuidv7()` (docs/adr/20260715093425-0012-uuid-v7-entity-ids.md).
 */
const NAMESPACE_HEX_LENGTH = 12;

export function deterministicUuid(namespace: string, counter: number): string {
  let hash = 0;
  for (const char of namespace) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  const ns = hash.toString(16).padStart(8, "0");
  const count = counter.toString(16).padStart(NAMESPACE_HEX_LENGTH, "0").slice(-NAMESPACE_HEX_LENGTH);
  return `${ns}-0000-7000-8000-${count}`;
}
