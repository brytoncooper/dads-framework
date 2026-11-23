import { z } from "zod";

/**
 * Created/updated pair for persisted entities (`...auditTimestamps`).
 * Soft-delete (`deletedAt`) never crosses the wire. Actor/audit fields
 * belong to the domain that uses them — they are not shared vocabulary.
 */
export const auditTimestamps = {
  createdAt: z.iso.datetime().meta({ description: "Creation (ISO 8601 UTC)" }),
  updatedAt: z.iso.datetime().meta({ description: "Last update (ISO 8601 UTC)" }),
};
