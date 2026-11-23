import { z } from "zod";

/**
 * Channel names are namespaced `<owner>.<name>` — the publishing domain owns
 * its prefix (spec §4). The platform treats names as opaque strings: a screen
 * bound to a channel nobody publishes renders its no-data state, never an
 * error (proof P4). The `v6.` prefix is reserved for the V6 bridge adapter's
 * compatibility channels (spec §16).
 */
export const CHANNEL_NAME_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

export const channelNameSchema = z
  .string()
  .regex(CHANNEL_NAME_PATTERN)
  .meta({ description: "Namespaced channel name, e.g. `events.updated`" });

/**
 * One channel delta — the only shape data ever wears between a publisher and
 * the glass. Payload schemas belong to the publishing domain's contract lib;
 * the platform (fan-out, runtime) never interprets them.
 */
export const channelEnvelopeSchema = z
  .strictObject({
    channel: channelNameSchema,
    seq: z.number().int().nonnegative().meta({ description: "Publisher-monotonic sequence number" }),
    at: z.iso.datetime().meta({ description: "Publish time (ISO 8601, publisher clock)" }),
    payload: z.unknown().meta({ description: "Domain-owned payload; opaque to the platform" }),
  })
  .meta({ description: "One channel delta" });

export type ChannelEnvelope = z.infer<typeof channelEnvelopeSchema>;
