import { z } from "zod";

/** The outbox stores one object whose fields are interpreted by its template. */
export const outboundEmailPropsSchema = z.record(z.string(), z.unknown());

export type OutboundEmailProps = z.infer<typeof outboundEmailPropsSchema>;
