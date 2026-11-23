import type { Clock } from "@dads-framework/core/runtime/clock";
import { mintUuidV7 } from "@dads-framework/core/contract";
import { notFound } from "@dads-framework/core/errors";

import {
  featureFlagBatchIdSchema,
  type FeatureFlagDefinition,
  type FeatureFlagState,
  type UpdateFeatureFlagsRequest,
} from "../../contract/index.js";
import type { FeatureFlagStore } from "../ports/feature-flag-store.js";
import type { TenantDirectory } from "../ports/tenant-directory.js";
import {
  planFeatureFlagBatch,
  requestedFeatureFlagSlugs,
  revisionChanged,
  selectedTenantIds,
} from "./plan-feature-flag-batch.js";

/** Plans and commits one revision-checked batch, writing history for every change. */
export class UpdateFeatureFlags {
  constructor(
    private readonly definitions: readonly FeatureFlagDefinition[],
    private readonly store: FeatureFlagStore,
    private readonly tenants: TenantDirectory,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly request: UpdateFeatureFlagsRequest;
    readonly actorId: string;
  }): Promise<readonly FeatureFlagState[]> {
    const slugs = requestedFeatureFlagSlugs({
      definitions: this.definitions,
      request: input.request,
    });
    const tenantNames = await this.activeTenantNames(
      selectedTenantIds(input.request),
    );
    const plan = planFeatureFlagBatch({
      actorId: input.actorId,
      batchId: featureFlagBatchIdSchema.parse(mintUuidV7()),
      currentStates: await this.store.listStates(slugs),
      now: this.clock.now(),
      request: input.request,
      tenantNames,
    });
    if ((await this.store.applyBatch(plan)) === "revision-conflict") {
      throw revisionChanged();
    }
    return plan.nextStates;
  }

  private async activeTenantNames(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const active = await this.tenants.findActiveTenants(ids);
    const names = new Map(active.map((tenant) => [tenant.id, tenant.name]));
    if (ids.some((id) => !names.has(id))) {
      throw notFound(
        "FEATURE_FLAG_TENANT_NOT_FOUND",
        "A selected tenant is not active",
      );
    }
    return names;
  }
}
