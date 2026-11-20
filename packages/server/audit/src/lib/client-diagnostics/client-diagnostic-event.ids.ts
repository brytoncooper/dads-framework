import type { z } from "zod";

import { entityIdSchema } from "@dads-framework/contract";

/** The kit mints this on report (never client-supplied — see `clientDiagnosticRow`). */
export const clientDiagnosticEventIdSchema = entityIdSchema(
  "ClientDiagnosticEventId",
  "Client diagnostic event id",
);

export type ClientDiagnosticEventId = z.infer<
  typeof clientDiagnosticEventIdSchema
>;
