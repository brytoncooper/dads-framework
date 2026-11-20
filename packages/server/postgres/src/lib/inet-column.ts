import { customType } from "drizzle-orm/pg-core";

/**
 * Postgres `inet` (an IP address, with an optional network prefix) as a
 * Drizzle column.
 *
 * drizzle-orm ships no `inet` builder, and the type exists in the schema for
 * one reason: `request_log.ip`. node-postgres has no
 * parser registered for the type, so it arrives as the text Postgres printed
 * — which is also the only representation callers need: nothing here does
 * subnet arithmetic, it is an address to record and compare by.
 */
export const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return "inet";
  },
});
