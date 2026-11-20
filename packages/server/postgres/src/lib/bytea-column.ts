import { customType } from "drizzle-orm/pg-core";

/**
 * Postgres `bytea` as a Drizzle column.
 *
 * drizzle-orm ships no `bytea` builder, so every binary column would otherwise
 * hand-roll the same `customType`. Bytes stay `Uint8Array` on the TypeScript
 * side because the packed formats that use this column (signature strokes
 * today) are produced by isomorphic code that must not touch `Buffer`;
 * node-postgres only serializes a real `Buffer`, so `toDriver` widens at the
 * boundary and callers never have to remember.
 */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  },
});
