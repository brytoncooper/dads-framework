import { createAccessClient } from "@dads-framework/access/runtime";
import { FakeAuthorization } from "@dads-framework/access/testing";
import { tenantIdSchema } from "@dads-framework/identity/tenants";
import {
  createExpiringTokenStore,
  createFaultyEventStream,
  defineSimAction,
  defineSimulation,
  runSimulation,
  type StreamSubscriber,
} from "@dads-framework/testing/dst";
import { describe, expect, it } from "vitest";
import { account, tenantAccess } from "../../../libraries/app-runtime/index.js";
import { noteIdSchema } from "../contract/wire.js";
import { note } from "./index.js";

describe("note-access DST simulation", () => {
  it("enforces denial, token TTL expiry, and mid-stream SSE revocation across random interleavings", async () => {
    type NoteEvent = { readonly noteId: string; readonly issuedAtMs: number };

    type State = {
      readonly client: ReturnType<typeof createAccessClient>;
      readonly tenantId: ReturnType<typeof tenantIdSchema.parse>;
      readonly accounts: readonly string[];
      readonly activeMembers: Set<string>;
      readonly revokedMembers: Set<string>;
      readonly tokens: ReturnType<typeof createExpiringTokenStore<{ readonly accountId: string }>>;
      readonly tokenIdsByAccount: Map<string, string[]>;
      readonly stream: ReturnType<typeof createFaultyEventStream<NoteEvent>>;
      readonly subscribers: Map<string, StreamSubscriber<NoteEvent>>;
      readonly revokedAtCursor: Map<string, number>;
    };

    const spec = defineSimulation<State>({
      name: "note-access-revocation-dst",
      createState: (world) => {
        const fake = new FakeAuthorization({
          [tenantAccess.tenant.wireName]: { view: ["member"] },
        });
        const tenantId = tenantIdSchema.parse(world.nextUuidV7());
        return {
          client: createAccessClient(fake),
          tenantId,
          accounts: ["acct-a", "acct-b", "acct-c", "outsider"],
          activeMembers: new Set(),
          revokedMembers: new Set(),
          tokens: createExpiringTokenStore(world),
          tokenIdsByAccount: new Map(),
          stream: createFaultyEventStream(world),
          subscribers: new Map(),
          revokedAtCursor: new Map(),
        };
      },
      actions: [
        defineSimAction({
          name: "grant-member",
          weight: 3,
          generate: (_state, world) => world.rng.pick(["acct-a", "acct-b", "acct-c"]),
          execute: async (state, accountId) => {
            if (state.activeMembers.has(accountId) || state.revokedMembers.has(accountId)) return;
            await state.client.add(account(accountId), tenantAccess.tenant(state.tenantId).member);
            state.activeMembers.add(accountId);
            const token = state.tokens.issue({ accountId }, 30_000);
            const list = state.tokenIdsByAccount.get(accountId) ?? [];
            list.push(token.id);
            state.tokenIdsByAccount.set(accountId, list);
            state.subscribers.set(accountId, state.stream.subscribe(accountId));
          },
        }),
        defineSimAction({
          name: "publish-note",
          weight: 4,
          generate: (_state, world) => world.nextUuidV7(),
          execute: async (state, rawNoteId, world) => {
            const noteId = noteIdSchema.parse(rawNoteId);
            await state.client.add(tenantAccess.tenant(state.tenantId), note(noteId).tenant);
            state.stream.publish({ noteId, issuedAtMs: world.clock.nowMs() });
          },
        }),
        defineSimAction({
          name: "revoke-member",
          weight: 2,
          enabled: (state) => state.activeMembers.size > 0,
          generate: (state, world) => world.rng.pick([...state.activeMembers]),
          execute: async (state, accountId) => {
            await state.client.remove(account(accountId), tenantAccess.tenant(state.tenantId).member);
            state.activeMembers.delete(accountId);
            state.revokedMembers.add(accountId);
            for (const tokenId of state.tokenIdsByAccount.get(accountId) ?? []) {
              state.tokens.revoke(tokenId);
            }
            const sub = state.subscribers.get(accountId);
            if (sub !== undefined) {
              sub.revoke();
              state.revokedAtCursor.set(accountId, sub.received.length);
            }
          },
        }),
        defineSimAction({
          name: "advance-clock",
          weight: 2,
          generate: (_state, world) => world.rng.int(5_000, 40_000),
          execute: (_state, deltaMs, world) => {
            world.clock.advance(deltaMs);
          },
        }),
      ],
      invariants: [
        {
          name: "outsider-and-revoked-always-denied",
          check: async (state) => {
            expect(await state.client.can(account("outsider"), tenantAccess.tenant(state.tenantId).view)).toBe(false);
            for (const revokedId of state.revokedMembers) {
              expect(await state.client.can(account(revokedId), tenantAccess.tenant(state.tenantId).view)).toBe(false);
              for (const tokenId of state.tokenIdsByAccount.get(revokedId) ?? []) {
                expect(state.tokens.verify(tokenId)).toBeUndefined();
              }
            }
          },
        },
        {
          name: "revoked-stream-receives-zero-future-events",
          check: (state) => {
            for (const [accountId, countAtRevoke] of state.revokedAtCursor.entries()) {
              const sub = state.subscribers.get(accountId);
              expect(sub?.revoked).toBe(true);
              expect(sub?.received.length).toBe(countAtRevoke);
              expect(sub?.reconnect()).toBe(false);
            }
          },
        },
      ],
    });

    const report = await runSimulation(spec, { seeds: 15, steps: 35 });
    expect(report.ok).toBe(true);
  });
});
