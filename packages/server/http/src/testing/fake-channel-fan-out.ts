import type { ChannelEnvelope } from "@dads-framework/core/contract";

import type { ChannelFanOut, ChannelListener, ChannelUnsubscribe } from "../channels/channel-fan-out.js";
import { InProcessChannelFanOut } from "../channels/in-process-channel-fan-out.js";

/** One event captured by {@link FakeChannelFanOut} when `publish` is called. */
export type PublishedChannelEvent = {
  readonly scopeId: string;
  readonly envelope: ChannelEnvelope;
};

/**
 * In-memory test double for {@link ChannelFanOut}.
 *
 * Records every published event for assertions while still delivering live
 * envelopes to subscribed listeners.
 */
export class FakeChannelFanOut implements ChannelFanOut {
  private readonly fanOut = new InProcessChannelFanOut();
  private readonly publishedEvents: PublishedChannelEvent[] = [];

  get published(): readonly PublishedChannelEvent[] {
    return this.publishedEvents;
  }

  publish(scopeId: string, envelope: ChannelEnvelope): void {
    this.publishedEvents.push({ scopeId, envelope });
    this.fanOut.publish(scopeId, envelope);
  }

  subscribe(scopeId: string, channels: readonly string[], listener: ChannelListener): ChannelUnsubscribe {
    return this.fanOut.subscribe(scopeId, channels, listener);
  }

  subscriberCount(scopeId?: string): number {
    return this.fanOut.subscriberCount(scopeId);
  }

  clearPublished(): void {
    this.publishedEvents.length = 0;
  }
}
