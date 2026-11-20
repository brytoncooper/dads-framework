/**
 * What: the composed queries answer from definitions first — public state
 * only for the declared public list and only as the platform, management in
 * definition order with cleanup readiness, history only for defined flags —
 * and composition refuses a slug defined twice or a public slug never defined.
 * Why: these are the walls between a stored row and a feature somebody sees.
 */
import { describe, expect, it } from "vitest";

import type { FeatureFlagState } from "../contract/index.js";
import { InMemoryFeatureFlagStore } from "../testing/in-memory-feature-flag-store.js";
import { FakeTenantDirectory } from "../testing/fake-tenant-directory.js";
import { featureFlagDefinitionFactory } from "../testing/feature-flag-definition.factory.js";
import { FixedClock } from "../testing/fixed-clock.js";
import { composeFeatureFlags } from "./compose-feature-flags.js";
import { defaultFeatureFlagState } from "./logic/transition-feature-flag-state.js";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const publicFlag = featureFlagDefinitionFactory({ slug: "docs.public-pages" });
const privateFlag = featureFlagDefinitionFactory({
  slug: "orders.private",
  globalStabilityDays: 30,
});

function everyone(slug: string, since: string): FeatureFlagState {
  return {
    ...defaultFeatureFlagState(slug),
    audienceMode: "EVERYONE",
    revision: 1,
    globalEnabledAt: since,
  };
}

function compose(states: readonly FeatureFlagState[]) {
  const store = new InMemoryFeatureFlagStore();
  store.seed(states);
  return composeFeatureFlags({
    definitions: [publicFlag, privateFlag],
    publicSlugs: [publicFlag.slug],
    store,
    tenants: new FakeTenantDirectory().name("t-1", "Renamed"),
    clock: new FixedClock(NOW),
  });
}

describe("composeFeatureFlags", () => {
  it("leaves a public flag out while it is off", async () => {
    expect(await compose([]).publicState.execute()).toEqual({ features: [] });
  });

  it("lists a public flag that is on for everyone", async () => {
    const flags = compose([everyone(publicFlag.slug, NOW.toISOString())]);
    expect(await flags.publicState.execute()).toEqual({
      features: [publicFlag.slug],
    });
  });

  it("never lists a public flag that is on only for selected tenants", async () => {
    const flags = compose([
      {
        ...defaultFeatureFlagState(publicFlag.slug),
        audienceMode: "SELECTED_TENANTS",
        revision: 1,
        rememberedTenants: [
          { tenantId: "t-1", tenantName: "One", enabledAt: NOW.toISOString() },
        ],
      },
    ]);
    expect(await flags.publicState.execute()).toEqual({ features: [] });
  });

  it("never lists a flag outside the public list, even when on for everyone", async () => {
    const flags = compose([everyone(privateFlag.slug, NOW.toISOString())]);
    expect(await flags.publicState.execute()).toEqual({ features: [] });
    expect(
      await flags.evaluator.isActive({
        slug: privateFlag.slug,
        context: { kind: "platform" },
      }),
    ).toBe(true);
  });

  it("lists every defined flag with current tenant names and cleanup readiness", async () => {
    const flags = compose([
      everyone(publicFlag.slug, "2026-09-01T12:00:00.000Z"),
      {
        ...everyone(privateFlag.slug, "2026-09-01T12:00:00.000Z"),
        rememberedTenants: [
          { tenantId: "t-1", tenantName: "Old name", enabledAt: null },
        ],
      },
      everyone("orders.deleted-from-code", "2026-01-01T00:00:00.000Z"),
    ]);
    const list = await flags.management.execute();
    expect(
      list.flags.map((flag) => [flag.definition.slug, flag.cleanupReady]),
    ).toEqual([
      [publicFlag.slug, true],
      [privateFlag.slug, false],
    ]);
    expect(list.flags[1]?.state.rememberedTenants[0]?.tenantName).toBe(
      "Renamed",
    );
  });

  it("answers history only for a defined flag", async () => {
    await expect(
      compose([]).history.execute({
        slug: "orders.deleted-from-code",
        page: 1,
        perPage: 10,
      }),
    ).rejects.toMatchObject({ code: "FEATURE_FLAG_NOT_FOUND" });
  });

  it("refuses a slug defined twice and a public slug that is not defined", () => {
    const base = {
      store: new InMemoryFeatureFlagStore(),
      tenants: new FakeTenantDirectory(),
      clock: new FixedClock(NOW),
    };
    expect(() =>
      composeFeatureFlags({ ...base, definitions: [publicFlag, publicFlag] }),
    ).toThrow(/defined more than once/);
    expect(() =>
      composeFeatureFlags({
        ...base,
        definitions: [privateFlag],
        publicSlugs: [publicFlag.slug],
      }),
    ).toThrow(/is not defined/);
  });
});
