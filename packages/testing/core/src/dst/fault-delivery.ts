import type { SimWorld } from "./sim-world.js";

/**
 * Fault-injecting adapters for at-least-once job/webhook delivery (duplicates,
 * reordering, delays, drops) and SSE live streams with mid-stream revocation.
 */

export type DeliveryEnvelope<Payload> = {
  readonly messageId: string;
  readonly deliveryNumber: number;
  readonly enqueuedAtMs: number;
  readonly deliverAtMs: number;
  readonly payload: Payload;
};

export type FaultyDeliveryOptions = {
  /** Probability that an enqueued message is scheduled twice. Defaults to `0.25`. */
  readonly duplicateRate?: number;
  /** Probability that a queued message is dropped before delivery. Defaults to `0.05`. */
  readonly dropRate?: number;
  /** Probability that two ready messages are delivered out of order. Defaults to `0.3`. */
  readonly reorderRate?: number;
  /** Maximum simulated delivery jitter in milliseconds. Defaults to `500`. */
  readonly maxDelayMs?: number;
};

export type FaultyDeliveryStats = {
  readonly enqueued: number;
  readonly duplicatesInjected: number;
  readonly dropped: number;
  readonly delivered: number;
  readonly pending: number;
};

export type FaultyDeliveryQueue<Payload> = {
  enqueue(payload: Payload, messageId?: string): string;
  /** Delivers one due message (possibly reordered); returns undefined if none is due. */
  deliverNext(handler: (envelope: DeliveryEnvelope<Payload>) => void | Promise<void>): Promise<boolean>;
  /** Advances the clock as needed and drains all queued messages through `handler`. */
  drainAll(handler: (envelope: DeliveryEnvelope<Payload>) => void | Promise<void>): Promise<number>;
  pendingCount(): number;
  stats(): FaultyDeliveryStats;
};

export function createFaultyDeliveryQueue<Payload>(
  world: SimWorld,
  options: FaultyDeliveryOptions = {},
): FaultyDeliveryQueue<Payload> {
  const rng = world.forkRng("dst:delivery");
  const duplicateRate = options.duplicateRate ?? 0.25;
  const dropRate = options.dropRate ?? 0.05;
  const reorderRate = options.reorderRate ?? 0.3;
  const maxDelayMs = Math.max(0, options.maxDelayMs ?? 500);

  const pending: DeliveryEnvelope<Payload>[] = [];
  const counters = { enqueued: 0, duplicatesInjected: 0, dropped: 0, delivered: 0 };

  const scheduleCopy = (messageId: string, payload: Payload, deliveryNumber: number): void => {
    const nowMs = world.clock.nowMs();
    const delayMs = maxDelayMs === 0 ? 0 : rng.int(0, maxDelayMs);
    pending.push({
      messageId,
      deliveryNumber,
      enqueuedAtMs: nowMs,
      deliverAtMs: nowMs + delayMs,
      payload,
    });
  };

  const enqueue = (payload: Payload, explicitId?: string): string => {
    const messageId = explicitId ?? world.nextUuidV7();
    counters.enqueued += 1;
    if (rng.bool(dropRate)) {
      counters.dropped += 1;
      world.record("fault:delivery-drop", { messageId });
      return messageId;
    }
    scheduleCopy(messageId, payload, 1);
    if (rng.bool(duplicateRate)) {
      counters.duplicatesInjected += 1;
      world.record("fault:delivery-duplicate", { messageId });
      scheduleCopy(messageId, payload, 2);
    }
    return messageId;
  };

  const pickReadyIndex = (): number => {
    const nowMs = world.clock.nowMs();
    const readyIndexes: number[] = [];
    for (let i = 0; i < pending.length; i += 1) {
      const item = pending[i];
      if (item !== undefined && item.deliverAtMs <= nowMs) readyIndexes.push(i);
    }
    if (readyIndexes.length === 0) return -1;
    if (readyIndexes.length > 1 && rng.bool(reorderRate)) {
      return rng.pick(readyIndexes);
    }
    return readyIndexes[0] ?? -1;
  };

  const deliverNext = async (
    handler: (envelope: DeliveryEnvelope<Payload>) => void | Promise<void>,
  ): Promise<boolean> => {
    const index = pickReadyIndex();
    if (index < 0) return false;
    const [envelope] = pending.splice(index, 1);
    if (envelope === undefined) return false;
    counters.delivered += 1;
    world.record("delivery:dispatch", { messageId: envelope.messageId, attempt: envelope.deliveryNumber });
    await handler(envelope);
    return true;
  };

  const drainAll = async (handler: (envelope: DeliveryEnvelope<Payload>) => void | Promise<void>): Promise<number> => {
    let dispatched = 0;
    while (pending.length > 0) {
      if (await deliverNext(handler)) {
        dispatched += 1;
        continue;
      }
      const nextDueMs = earliestDueMs(pending);
      if (nextDueMs > world.clock.nowMs()) {
        world.clock.advance(nextDueMs - world.clock.nowMs());
      }
    }
    return dispatched;
  };

  return {
    enqueue,
    deliverNext,
    drainAll,
    pendingCount: () => pending.length,
    stats: () => ({ ...counters, pending: pending.length }),
  };
}

export type StreamSubscriber<Event> = {
  readonly id: string;
  readonly received: readonly Event[];
  readonly revoked: boolean;
  readonly closed: boolean;
  revoke(): void;
  disconnect(): void;
  reconnect(fromCursor?: number): boolean;
};

export type FaultyEventStream<Event> = {
  subscribe(id?: string): StreamSubscriber<Event>;
  publish(event: Event): number;
  readonly publishedCount: number;
};

/**
 * Deterministic SSE / live-channel stream simulator with mid-stream access
 * revocation, transient disconnects, and cursor-based reconnects. Once revoked,
 * a subscriber is closed permanently and can never reconnect or receive events.
 */
export function createFaultyEventStream<Event>(world: SimWorld): FaultyEventStream<Event> {
  const history: Event[] = [];
  const subscribers = new Map<
    string,
    {
      readonly id: string;
      readonly received: Event[];
      revoked: boolean;
      closed: boolean;
      cursor: number;
    }
  >();

  const subscribe = (explicitId?: string): StreamSubscriber<Event> => {
    const id = explicitId ?? world.nextUuidV7();
    const received: Event[] = [];
    const state = { id, received, revoked: false, closed: false, cursor: history.length };
    subscribers.set(id, state);
    world.record("stream:subscribe", { id });
    return {
      id,
      get received() {
        return state.received;
      },
      get revoked() {
        return state.revoked;
      },
      get closed() {
        return state.closed;
      },
      revoke: () => {
        state.revoked = true;
        state.closed = true;
        world.record("stream:revoke", { id });
      },
      disconnect: () => {
        state.closed = true;
        world.record("stream:disconnect", { id });
      },
      reconnect: (fromCursor?: number) => {
        if (state.revoked) return false;
        state.closed = false;
        const start = Math.max(0, fromCursor ?? state.cursor);
        for (let i = start; i < history.length; i += 1) {
          const event = history[i];
          if (event !== undefined) state.received.push(event);
        }
        state.cursor = history.length;
        world.record("stream:reconnect", { id, start });
        return true;
      },
    };
  };

  const publish = (event: Event): number => {
    history.push(event);
    let delivered = 0;
    for (const sub of subscribers.values()) {
      if (sub.revoked || sub.closed) continue;
      sub.received.push(event);
      sub.cursor = history.length;
      delivered += 1;
    }
    world.record("stream:publish", { cursor: history.length, delivered });
    return delivered;
  };

  return {
    subscribe,
    publish,
    get publishedCount() {
      return history.length;
    },
  };
}

function earliestDueMs<Payload>(envelopes: readonly DeliveryEnvelope<Payload>[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const envelope of envelopes) {
    if (envelope.deliverAtMs < min) min = envelope.deliverAtMs;
  }
  return min;
}
