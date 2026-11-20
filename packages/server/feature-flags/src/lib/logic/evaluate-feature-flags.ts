import { createHash } from "node:crypto";

import type {
  FeatureFlagDefinition,
  FeatureFlagState,
} from "../../contract/index.js";

/**
 * Whose answer is being asked for. `platform` counts flags that are on for
 * everyone only; `tenant` also counts that tenant's pilot selection.
 */
export type FeatureFlagContext =
  | { readonly kind: "platform" }
  | { readonly kind: "tenant"; readonly tenantId: string };

/**
 * The sorted allow-list for one context. It walks the definitions, so a stored
 * row for a slug nobody defines never becomes a feature.
 */
export function evaluateFeatureFlags(input: {
  readonly definitions: readonly FeatureFlagDefinition[];
  readonly states: readonly FeatureFlagState[];
  readonly context: FeatureFlagContext;
}): readonly string[] {
  const stateBySlug = new Map(input.states.map((state) => [state.slug, state]));
  return input.definitions
    .map((definition) => definition.slug)
    .filter((slug) => isOn(stateBySlug.get(slug), input.context))
    .sort();
}

function isOn(
  state: FeatureFlagState | undefined,
  context: FeatureFlagContext,
): boolean {
  if (state === undefined) return false;
  switch (state.audienceMode) {
    case "OFF":
      return false;
    case "EVERYONE":
      return true;
    case "SELECTED_TENANTS":
      return context.kind === "tenant" && isSelected(state, context.tenantId);
  }
}

function isSelected(state: FeatureFlagState, tenantId: string): boolean {
  return state.rememberedTenants.some(
    (tenant) => tenant.tenantId === tenantId && tenant.enabledAt !== null,
  );
}

/** SHA-256 of the sorted allow-list: equal lists hash equal, whatever order they arrived in. */
export function hashFeatureState(features: readonly string[]): string {
  return createHash("sha256")
    .update([...features].sort().join("\n"))
    .digest("hex");
}
