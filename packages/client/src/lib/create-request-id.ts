/**
 * A random v4 UUID for the request-id header.
 *
 * `crypto.randomUUID` exists only in secure contexts (https or localhost), so
 * a page served over plain http on a local network — a shared terminal, a test
 * computer reaching a dev machine by its LAN address — has no such function,
 * and every API call would throw before it left the browser.
 * `crypto.getRandomValues` is available in every context, so the fallback
 * builds the same v4 shape from it.
 */
export function createRequestId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return uuidV4FromRandomBytes(crypto.getRandomValues(new Uint8Array(16)));
}

/** Stamp the version (4) and variant (10xx) bits, then format 8-4-4-4-12. */
export function uuidV4FromRandomBytes(bytes: Uint8Array): string {
  const stamped = Uint8Array.from(bytes);
  stamped[6] = ((stamped[6] ?? 0) & 0x0f) | 0x40;
  stamped[8] = ((stamped[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(stamped, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}
