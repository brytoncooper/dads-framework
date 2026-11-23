import type { ChannelEnvelope } from "@dads-framework/core/contract";

export { channelEnvelopeSchema, channelNameSchema, type ChannelEnvelope } from "@dads-framework/core/contract";

/** Receives published channel envelopes for a subscribed scope and channel. */
export type ChannelListener = (envelope: ChannelEnvelope) => void | Promise<void>;

/** Releases a channel subscription; safe to call more than once. */
export type ChannelUnsubscribe = () => void;

/**
 * Scope-keyed publish/subscribe bus for live channel updates.
 *
 * Implementations deliver envelopes only to listeners subscribed to both the
 * matching `scopeId` and `envelope.channel`.
 */
export type ChannelFanOut = {
  publish(scopeId: string, envelope: ChannelEnvelope): void;
  subscribe(scopeId: string, channels: readonly string[], listener: ChannelListener): ChannelUnsubscribe;
};
