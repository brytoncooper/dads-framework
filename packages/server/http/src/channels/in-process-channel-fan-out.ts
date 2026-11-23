import type { ChannelEnvelope } from "@dads-framework/core/contract";

import type { ChannelFanOut, ChannelListener, ChannelUnsubscribe } from "./channel-fan-out.js";

/** Minimal structural logger for reporting isolated channel listener failures. */
export type ChannelFanOutLog = {
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
};

export type InProcessChannelFanOutOptions = {
  readonly log?: ChannelFanOutLog;
};

type ChannelSubscription = {
  readonly scopeId: string;
  readonly channels: readonly string[];
  readonly listener: ChannelListener;
};

/**
 * Single-process implementation of {@link ChannelFanOut}.
 *
 * Listener failures are isolated and reported via `options.log`, and empty
 * channel/scope buckets are removed automatically when the last subscriber
 * disconnects.
 */
export class InProcessChannelFanOut implements ChannelFanOut {
  private readonly log: ChannelFanOutLog | undefined;
  private readonly subscriptionsByScope = new Map<string, Set<ChannelSubscription>>();
  private readonly listenersByScopeChannel = new Map<string, Map<string, Set<ChannelSubscription>>>();

  constructor(options: InProcessChannelFanOutOptions = {}) {
    this.log = options.log;
  }

  publish(scopeId: string, envelope: ChannelEnvelope): void {
    const subscribers = this.listenersByScopeChannel.get(scopeId)?.get(envelope.channel);
    if (subscribers === undefined) {
      return;
    }
    for (const subscription of [...subscribers]) {
      this.invokeListener(scopeId, envelope, subscription.listener);
    }
  }

  subscribe(scopeId: string, channels: readonly string[], listener: ChannelListener): ChannelUnsubscribe {
    const uniqueChannels = [...new Set(channels)];
    if (uniqueChannels.length === 0) {
      return () => undefined;
    }
    const subscription: ChannelSubscription = {
      scopeId,
      channels: uniqueChannels,
      listener,
    };
    this.addSubscription(subscription);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this.removeSubscription(subscription);
    };
  }

  subscriberCount(scopeId?: string): number {
    if (scopeId !== undefined) {
      return this.subscriptionsByScope.get(scopeId)?.size ?? 0;
    }
    let total = 0;
    for (const set of this.subscriptionsByScope.values()) {
      total += set.size;
    }
    return total;
  }

  private addSubscription(subscription: ChannelSubscription): void {
    const { scopeId, channels } = subscription;
    const scopeSubscriptions = this.subscriptionsByScope.get(scopeId) ?? new Set<ChannelSubscription>();
    scopeSubscriptions.add(subscription);
    this.subscriptionsByScope.set(scopeId, scopeSubscriptions);

    const byChannel = this.listenersByScopeChannel.get(scopeId) ?? new Map<string, Set<ChannelSubscription>>();
    for (const channel of channels) {
      const channelSet = byChannel.get(channel) ?? new Set<ChannelSubscription>();
      channelSet.add(subscription);
      byChannel.set(channel, channelSet);
    }
    this.listenersByScopeChannel.set(scopeId, byChannel);
  }

  private removeSubscription(subscription: ChannelSubscription): void {
    const { scopeId, channels } = subscription;
    const scopeSubscriptions = this.subscriptionsByScope.get(scopeId);
    if (scopeSubscriptions !== undefined) {
      scopeSubscriptions.delete(subscription);
      if (scopeSubscriptions.size === 0) {
        this.subscriptionsByScope.delete(scopeId);
      }
    }

    const byChannel = this.listenersByScopeChannel.get(scopeId);
    if (byChannel === undefined) {
      return;
    }
    for (const channel of channels) {
      this.removeChannelSubscription(byChannel, channel, subscription);
    }
    if (byChannel.size === 0) {
      this.listenersByScopeChannel.delete(scopeId);
    }
  }

  private removeChannelSubscription(
    byChannel: Map<string, Set<ChannelSubscription>>,
    channel: string,
    subscription: ChannelSubscription,
  ): void {
    const channelSet = byChannel.get(channel);
    if (channelSet === undefined) {
      return;
    }
    channelSet.delete(subscription);
    if (channelSet.size === 0) {
      byChannel.delete(channel);
    }
  }

  private invokeListener(scopeId: string, envelope: ChannelEnvelope, listener: ChannelListener): void {
    try {
      const result = listener(envelope);
      if (result instanceof Promise) {
        void result.catch((error: unknown) => {
          this.log?.error(
            { scopeId, channel: envelope.channel, err: error },
            "channel subscriber failed asynchronously",
          );
        });
      }
    } catch (error: unknown) {
      this.log?.error({ scopeId, channel: envelope.channel, err: error }, "channel subscriber threw synchronously");
    }
  }
}

/** Create an in-process channel fan-out bus. */
export function createChannelFanOut(options?: InProcessChannelFanOutOptions): InProcessChannelFanOut {
  return new InProcessChannelFanOut(options);
}
