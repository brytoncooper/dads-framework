import type { z } from "zod";

import { entityIdSchema } from "@dads-framework/contract";

/** One queued outbox row (`authorization_outbox`), minted by the producer that enqueues it. */
export const accessChangeIdSchema = entityIdSchema(
  "AccessChangeId",
  "Access change outbox row id",
);

export type AccessChangeId = z.infer<typeof accessChangeIdSchema>;
