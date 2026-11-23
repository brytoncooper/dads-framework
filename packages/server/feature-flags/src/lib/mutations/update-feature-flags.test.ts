/**
 * What: a management batch applies every change or none, refuses unknown and
 * repeated slugs and inactive tenants, and records who changed what.
 * Why: a half-applied batch leaves an audience nobody chose, and history is
 * the only answer to "who turned this on".
 */
import { describe, expect, it } from "vitest";

import { defaultFeatureFlagState } from "../logic/transition-feature-flag-state.js";
import { InMemoryFeatureFlagStore } from "../../testing/in-memory-feature-flag-store.js";
import { FakeTenantDirectory } from "../../testing/fake-tenant-directory.js";
import { featureFlagDefinitionFactory } from "../../testing/feature-flag-definition.factory.js";
import { FixedClock } from "../../testing/fixed-clock.js";
import { UpdateFeatureFlags } from "./update-feature-flags.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const first = featureFlagDefinitionFactory({ slug: "orders.first" });
const second = featureFlagDefinitionFactory({ slug: "orders.second" });

function setUp(tenants = new FakeTenantDirectory()) {
  const store = new InMemoryFeatureFlagStore();
  const mutation = new UpdateFeatureFlags([first, second], store, tenants, new FixedClock(NOW));
  return { store, mutation };
}

describe("UpdateFeatureFlags", () => {
  it("does not partially apply a batch when a revision is stale", async () => {
    const { store, mutation } = setUp();
    store.seed([{ ...defaultFeatureFlagState(first.slug), revision: 1 }]);
    await expect(
      mutation.execute({
        actorId: "user-1",
        request: {
          changes: [
            { slug: first.slug, expectedRevision: 1, mode: "EVERYONE" },
            { slug: second.slug, expectedRevision: 1, mode: "EVERYONE" },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "FEATURE_FLAG_STATE_CHANGED" });
    expect(await store.listStates([first.slug, second.slug])).toEqual([
      { ...defaultFeatureFlagState(first.slug), revision: 1 },
    ]);
  });

  it("records each change in history with its batch, actor, time and note", async () => {
    const { store, mutation } = setUp(new FakeTenantDirectory().name("t-1", "Acme"));
    const states = await mutation.execute({
      actorId: "user-1",
      request: {
        changes: [
          {
            slug: first.slug,
            expectedRevision: 0,
            mode: "SELECTED_TENANTS",
            tenantIds: ["t-1"],
            note: "pilot",
          },
          { slug: second.slug, expectedRevision: 0, mode: "EVERYONE" },
        ],
      },
    });
    expect(states.map((state) => state.revision)).toEqual([1, 1]);
    expect(states[0]?.rememberedTenants).toEqual([
      { tenantId: "t-1", tenantName: "Acme", enabledAt: NOW.toISOString() },
    ]);
    const history = await store.listHistory({
      slug: first.slug,
      page: 1,
      perPage: 10,
    });
    expect(history.rows).toEqual([
      expect.objectContaining({
        slug: first.slug,
        revision: 1,
        note: "pilot",
        changedBy: "user-1",
        changedAt: NOW.toISOString(),
        previousState: defaultFeatureFlagState(first.slug),
      }),
    ]);
    const other = await store.listHistory({
      slug: second.slug,
      page: 1,
      perPage: 10,
    });
    expect(other.rows[0]?.batchId).toBe(history.rows[0]?.batchId);
    expect(other.rows[0]).not.toHaveProperty("note");
  });

  it("refuses a tenant the application says is not active, writing nothing", async () => {
    const { store, mutation } = setUp(new FakeTenantDirectory().deactivate("gone"));
    await expect(
      mutation.execute({
        actorId: "user-1",
        request: {
          changes: [
            {
              slug: first.slug,
              expectedRevision: 0,
              mode: "SELECTED_TENANTS",
              tenantIds: ["gone"],
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "FEATURE_FLAG_TENANT_NOT_FOUND" });
    expect(await store.listStates([first.slug])).toEqual([]);
  });

  it("refuses an undefined slug and a slug repeated in one batch", async () => {
    const { mutation } = setUp();
    await expect(
      mutation.execute({
        actorId: "user-1",
        request: {
          changes: [{ slug: "orders.unknown", expectedRevision: 0, mode: "OFF" }],
        },
      }),
    ).rejects.toMatchObject({ code: "FEATURE_FLAG_NOT_FOUND" });
    await expect(
      mutation.execute({
        actorId: "user-1",
        request: {
          changes: [
            { slug: first.slug, expectedRevision: 0, mode: "OFF" },
            { slug: first.slug, expectedRevision: 0, mode: "EVERYONE" },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "FEATURE_FLAG_CHANGE_DUPLICATED" });
  });
});
