import { z } from "zod";

/** A nonnegative PostgreSQL integer revision on the wire. */
export const rowVersionSchema = z.int32().nonnegative();

/** Spread into a strict update request. The caller must send the loaded version. */
export const expectedRowVersionFields = {
  expectedRowVersion: rowVersionSchema,
};

export const ROW_VERSION_CONFLICT = "ROW_VERSION_CONFLICT";
