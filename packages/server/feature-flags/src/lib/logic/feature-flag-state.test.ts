/**
 * What: the audience modes evaluate per context, and transitions remember
 * pilot tenants across OFF and EVERYONE with their timing cleared.
 * Why: the evaluation is the whole product of the package; a pilot that leaks
 * into another tenant or into the platform context turns a feature on for
 * people who were never chosen.
 */
import { describe, expect, it } from "vitest";

import type { FeatureFlagState } from "../../contract/index.js";
import { featureFlagDefinitionFactory } from "../../testing/feature-flag-definition.factory.js";
import { evaluateFeatureFlags, hashFeatureState } from "./evaluate-feature-flags.js";
import { defaultFeatureFlagState, transitionFeatureFlagState } from "./transition-feature-flag-state.js";

const definition = featureFlagDefinitionFactory();
const ACTOR_ID = "user-1";
const TENANT = "tenant-a";
const OTHER_TENANT = "tenant-b";

function at(day: number): Date {
  return new Date(`2026-09-${String(day).padStart(2, "0")}T12:00:00.000Z`);
}

function change(current: FeatureFlagState, mode: "OFF" | "EVERYONE", when: Date): FeatureFlagState {
  return transitionFeatureFlagState({
    current,
    change: { slug: definition.slug, expectedRevision: current.revision, mode },
    now: when,
    actorId: ACTOR_ID,
    tenantNames: new Map(),
  });
}

function select(current: FeatureFlagState, tenantIds: [string, ...string[]], when: Date): FeatureFlagState {
  return transitionFeatureFlagState({
    current,
    change: {
      slug: definition.slug,
      expectedRevision: current.revision,
      mode: "SELECTED_TENANTS",
      tenantIds,
    },
    now: when,
    actorId: ACTOR_ID,
    tenantNames: new Map(tenantIds.map((id) => [id, `Tenant ${id}`])),
  });
}

/** Features for one tenant, or for the platform when `tenantId` is "platform". */
function featuresFor(state: FeatureFlagState, tenantId: string): readonly string[] {
  return evaluateFeatureFlags({
    definitions: [definition],
    states: [state],
    context: tenantId === "platform" ? { kind: "platform" } : { kind: "tenant", tenantId },
  });
}

describe("feature flag state logic", () => {
  it("defaults missing rows off and keeps platform context to global rollouts", () => {
    const off = defaultFeatureFlagState(definition.slug);
    const everyone = change(off, "EVERYONE", at(1));
    expect(featuresFor(off, TENANT)).toEqual([]);
    expect(
      evaluateFeatureFlags({
        definitions: [definition],
        states: [],
        context: { kind: "platform" },
      }),
    ).toEqual([]);
    expect(featuresFor(everyone, "platform")).toEqual([definition.slug]);
    expect(featuresFor(everyone, TENANT)).toEqual([definition.slug]);
  });

  it("never turns on a stored row whose slug is not defined", () => {
    const stray: FeatureFlagState = {
      ...change(defaultFeatureFlagState("orders.retired"), "EVERYONE", at(1)),
    };
    expect(
      evaluateFeatureFlags({
        definitions: [definition],
        states: [stray],
        context: { kind: "platform" },
      }),
    ).toEqual([]);
  });

  it("hashes the allow-list the same whatever order it arrives in", () => {
    expect(hashFeatureState(["b.flag", "a.flag"])).toBe(hashFeatureState(["a.flag", "b.flag"]));
    expect(hashFeatureState(["a.flag"])).not.toBe(hashFeatureState([]));
  });

  it("keeps selected pilot timing only while selected and starts it again on return", () => {
    const selected = select(defaultFeatureFlagState(definition.slug), [TENANT], at(1));
    const stillSelected = select(selected, [TENANT, OTHER_TENANT], at(2));
    expect(stillSelected.rememberedTenants).toEqual([
      {
        tenantId: TENANT,
        tenantName: `Tenant ${TENANT}`,
        enabledAt: at(1).toISOString(),
      },
      {
        tenantId: OTHER_TENANT,
        tenantName: `Tenant ${OTHER_TENANT}`,
        enabledAt: at(2).toISOString(),
      },
    ]);
    const off = change(stillSelected, "OFF", at(3));
    expect(off.rememberedTenants.map((tenant) => tenant.enabledAt)).toEqual([null, null]);
    const restored = select(off, [TENANT], at(4));
    expect(restored.rememberedTenants).toEqual([
      {
        tenantId: OTHER_TENANT,
        tenantName: `Tenant ${OTHER_TENANT}`,
        enabledAt: null,
      },
      {
        tenantId: TENANT,
        tenantName: `Tenant ${TENANT}`,
        enabledAt: at(4).toISOString(),
      },
    ]);
  });

  it("turns an OFF flag off everywhere while remembering its pilots with enabledAt cleared", () => {
    const off = change(select(defaultFeatureFlagState(definition.slug), [TENANT], at(1)), "OFF", at(2));
    expect(off.rememberedTenants).toEqual([{ tenantId: TENANT, tenantName: `Tenant ${TENANT}`, enabledAt: null }]);
    expect(featuresFor(off, TENANT)).toEqual([]);
    expect(featuresFor(off, "platform")).toEqual([]);
  });

  it("counts a pilot only in its own tenant context and only while its enabledAt is set", () => {
    const selected = select(defaultFeatureFlagState(definition.slug), [TENANT], at(1));
    const clearedPilot: FeatureFlagState = {
      ...selected,
      rememberedTenants: selected.rememberedTenants.map((tenant) => ({
        ...tenant,
        enabledAt: null,
      })),
    };
    expect(featuresFor(selected, TENANT)).toEqual([definition.slug]);
    expect(featuresFor(selected, OTHER_TENANT)).toEqual([]);
    expect(featuresFor(selected, "platform")).toEqual([]);
    expect(featuresFor(clearedPilot, TENANT)).toEqual([]);
  });

  it("sets globalEnabledAt exactly while the mode is EVERYONE and keeps its first start", () => {
    const everyone = change(defaultFeatureFlagState(definition.slug), "EVERYONE", at(1));
    const again = change(everyone, "EVERYONE", at(5));
    expect(everyone.globalEnabledAt).toBe(at(1).toISOString());
    expect(again.globalEnabledAt).toBe(at(1).toISOString());
    expect(change(again, "OFF", at(6)).globalEnabledAt).toBeNull();
    expect(select(again, [TENANT], at(6)).globalEnabledAt).toBeNull();
  });
});
