import { customType } from "drizzle-orm/pg-core";

/**
 * Postgres `xid8` (a 64-bit transaction id) as a Drizzle column.
 *
 * drizzle-orm ships no `xid8` builder, and the type exists in the schema for
 * one reason: `audit_log.transaction_id` groups every row a single transaction
 * changed. node-postgres has no parser registered for the type, so
 * it arrives as the decimal string Postgres printed — which is also the only
 * lossless JavaScript representation of a value that outgrows `number`. It
 * stays a string here rather than becoming a `bigint`, because nothing
 * arithmetic is done with it: it is an identity to group and compare by.
 */
export const xid8 = customType<{ data: string; driverData: string }>({
  dataType() {
    return "xid8";
  },
});
