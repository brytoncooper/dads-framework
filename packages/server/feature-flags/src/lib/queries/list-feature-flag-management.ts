import type { Clock } from "@dads-framework/runtime/clock";

import type {
  FeatureFlagDefinition,
  FeatureFlagManagementList,
  FeatureFlagState,
} from "../../contract/index.js";
import { defaultFeatureFlagState } from "../logic/transition-feature-flag-state.js";
import type { FeatureFlagStore } from "../ports/feature-flag-store.js";
import type { TenantDirectory } from "../ports/tenant-directory.js";

const DAY_MS = 86_400_000;

/**
 * Every defined flag with its state, in definition order. A stored row whose
 * definition was deleted stays inert and unlisted.
 */
export class ListFeatureFlagManagement {
  constructor(
    private readonly definitions: readonly FeatureFlagDefinition[],
    private readonly store: FeatureFlagStore,
    private readonly tenants: TenantDirectory,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<FeatureFlagManagementList> {
    const states = await this.store.listStates(
      this.definitions.map((definition) => definition.slug),
    );
    const names = await this.currentTenantNames(states);
    const bySlug = new Map(states.map((state) => [state.slug, state]));
    const now = this.clock.now();
    return {
      flags: this.definitions.map((definition) => {
        const state = withCurrentNames(
          bySlug.get(definition.slug) ??
            defaultFeatureFlagState(definition.slug),
          names,
        );
        return {
          definition,
          state,
          cleanupReady: isCleanupReady(definition, state, now),
        };
      }),
    };
  }

  private async currentTenantNames(
    states: readonly FeatureFlagState[],
  ): Promise<ReadonlyMap<string, string>> {
    const active = await this.tenants.findActiveTenants(
      states.flatMap((state) =>
        state.rememberedTenants.map((tenant) => tenant.tenantId),
      ),
    );
    return new Map(active.map((tenant) => [tenant.id, tenant.name]));
  }
}

function withCurrentNames(
  state: FeatureFlagState,
  names: ReadonlyMap<string, string>,
): FeatureFlagState {
  return {
    ...state,
    rememberedTenants: state.rememberedTenants.map((tenant) => ({
      ...tenant,
      tenantName: names.get(tenant.tenantId) ?? tenant.tenantName,
    })),
  };
}

function isCleanupReady(
  definition: FeatureFlagDefinition,
  state: FeatureFlagState,
  now: Date,
): boolean {
  if (state.audienceMode !== "EVERYONE" || state.globalEnabledAt === null) {
    return false;
  }
  const onFor = now.getTime() - new Date(state.globalEnabledAt).getTime();
  return onFor >= definition.globalStabilityDays * DAY_MS;
}
