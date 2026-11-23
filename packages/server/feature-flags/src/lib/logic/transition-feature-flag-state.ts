import type { FeatureFlagRememberedTenant, FeatureFlagState, UpdateFeatureFlagInput } from "../../contract/index.js";

/** A flag with no stored row: the contract's default. */
export function defaultFeatureFlagState(slug: string): FeatureFlagState {
  return {
    slug,
    audienceMode: "OFF",
    rememberedTenants: [],
    revision: 0,
    globalEnabledAt: null,
    updatedAt: null,
    updatedBy: null,
  };
}

type TransitionInput = {
  readonly current: FeatureFlagState;
  readonly change: UpdateFeatureFlagInput;
  readonly now: Date;
  readonly actorId: string;
  readonly tenantNames: ReadonlyMap<string, string>;
};

/**
 * The next state for one change. Pilot tenants are remembered across OFF and
 * EVERYONE with `enabledAt` cleared, so turning a flag back to selected
 * tenants starts their timing again.
 */
export function transitionFeatureFlagState(input: TransitionInput): FeatureFlagState {
  const updatedAt = input.now.toISOString();
  const common = {
    slug: input.current.slug,
    revision: input.current.revision + 1,
    updatedAt,
    updatedBy: input.actorId,
  };
  const { change, current } = input;
  switch (change.mode) {
    case "OFF":
      return {
        ...common,
        audienceMode: "OFF",
        rememberedTenants: deselectAll(current.rememberedTenants),
        globalEnabledAt: null,
      };
    case "EVERYONE":
      return {
        ...common,
        audienceMode: "EVERYONE",
        rememberedTenants: deselectAll(current.rememberedTenants),
        globalEnabledAt: keptGlobalEnabledAt(current) ?? updatedAt,
      };
    case "SELECTED_TENANTS":
      return {
        ...common,
        audienceMode: "SELECTED_TENANTS",
        rememberedTenants: selectTenants(input, change.tenantIds, updatedAt),
        globalEnabledAt: null,
      };
  }
}

function deselectAll(tenants: readonly FeatureFlagRememberedTenant[]): FeatureFlagRememberedTenant[] {
  return tenants.map((tenant) => ({ ...tenant, enabledAt: null }));
}

/** Staying on for everyone keeps the original start, so cleanup timing is not reset. */
function keptGlobalEnabledAt(current: FeatureFlagState): string | null {
  return current.audienceMode === "EVERYONE" ? current.globalEnabledAt : null;
}

function selectTenants(
  input: TransitionInput,
  tenantIds: readonly string[],
  updatedAt: string,
): FeatureFlagRememberedTenant[] {
  const selected = new Set(tenantIds);
  const previous = new Map(input.current.rememberedTenants.map((tenant) => [tenant.tenantId, tenant]));
  const stillSelected = input.current.audienceMode === "SELECTED_TENANTS";
  const unselected = input.current.rememberedTenants.filter((tenant) => !selected.has(tenant.tenantId));
  return [
    ...deselectAll(unselected),
    ...tenantIds.map((tenantId) => {
      const existing = previous.get(tenantId);
      return {
        tenantId,
        tenantName: input.tenantNames.get(tenantId) ?? existing?.tenantName ?? tenantId,
        enabledAt: (stillSelected ? existing?.enabledAt : undefined) ?? updatedAt,
      };
    }),
  ];
}
