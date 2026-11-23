import type { z } from "zod";

import { isPermissionToken, type PermissionToken } from "@dads-framework/access";

/** Valid action name format: lowercase dot/hyphen-separated segments (e.g. `cache.clear`, `billing.reconcile-invoices`). */
export const LIVE_ACTION_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** Minimum length of a live action description so operators always see clear intent. */
export const LIVE_ACTION_MIN_DESCRIPTION_LENGTH = 10;

export type LiveActionDangerLevel = "safe" | "cautious" | "destructive";

export type LiveActionOutcome = "running" | "succeeded" | "failed";

export type LiveActionCaller = {
  readonly type: string;
  readonly id: string;
};

export type LiveActionContext<TInput> = {
  readonly input: TInput;
  readonly caller: LiveActionCaller;
  readonly reason: string;
  readonly runId: string;
  readonly signal?: AbortSignal;
};

export type LiveActionResult = {
  readonly summary: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type LiveActionResourcePermission = {
  readonly entity: string;
  readonly permission: string;
  readonly resourceId: string;
};

export type LiveActionPermission = PermissionToken | LiveActionResourcePermission;

export type LiveActionSpec<TInput> = {
  readonly name: string;
  readonly description: string;
  readonly dangerLevel: LiveActionDangerLevel;
  readonly permission: LiveActionPermission;
  readonly inputSchema: z.ZodType<TInput>;
  readonly redactInput?: (input: TInput) => unknown;
  readonly execute: (context: LiveActionContext<TInput>) => Promise<LiveActionResult>;
};

/**
 * Validated live-action definition.
 *
 * Method syntax on `execute` and `redactInput` preserves typed action specs at
 * definition sites while allowing heterogeneously typed actions to be stored in
 * a single {@link LiveActionRegistry} after boundary validation via `inputSchema`.
 */
export type LiveActionDefinition<TInput = unknown> = {
  readonly name: string;
  readonly description: string;
  readonly dangerLevel: LiveActionDangerLevel;
  readonly permission: LiveActionPermission;
  readonly inputSchema: z.ZodType<TInput>;
  redactInput?(input: TInput): unknown;
  execute(context: LiveActionContext<TInput>): Promise<LiveActionResult>;
};

const VALID_DANGER_LEVELS: ReadonlySet<string> = new Set(["safe", "cautious", "destructive"]);

function validateDangerLevel(dangerLevel: LiveActionDangerLevel): void {
  if (!VALID_DANGER_LEVELS.has(dangerLevel)) {
    throw new Error(`Invalid live action danger level: ${dangerLevel}`);
  }
}

function validatePermission(permission: LiveActionPermission): void {
  if (isPermissionToken(permission)) {
    if (permission.entityWireName.trim().length === 0 || permission.permissionName.trim().length === 0) {
      throw new Error("Live action permission token must include non-empty entity and permission names");
    }
    return;
  }
  if (
    permission.entity.trim().length === 0 ||
    permission.permission.trim().length === 0 ||
    permission.resourceId.trim().length === 0
  ) {
    throw new Error("Live action resource permission must include non-empty entity, permission, and resourceId");
  }
}

/** Validate core metadata invariants shared by definition and registration. */
export function assertValidLiveActionMetadata(action: {
  readonly name: string;
  readonly description: string;
  readonly dangerLevel: LiveActionDangerLevel;
  readonly permission: LiveActionPermission;
}): void {
  if (!LIVE_ACTION_NAME_PATTERN.test(action.name)) {
    throw new Error(`Invalid live action name "${action.name}": must match ${LIVE_ACTION_NAME_PATTERN.source}`);
  }
  if (action.description.trim().length < LIVE_ACTION_MIN_DESCRIPTION_LENGTH) {
    throw new Error(
      `Live action "${action.name}" description must be at least ${String(LIVE_ACTION_MIN_DESCRIPTION_LENGTH)} characters`,
    );
  }
  validateDangerLevel(action.dangerLevel);
  validatePermission(action.permission);
}

/** Define and validate an audited live-environment operational action. */
export function defineLiveAction<TInput>(spec: LiveActionSpec<TInput>): LiveActionDefinition<TInput> {
  assertValidLiveActionMetadata(spec);
  return Object.freeze({
    name: spec.name,
    description: spec.description,
    dangerLevel: spec.dangerLevel,
    permission: spec.permission,
    inputSchema: spec.inputSchema,
    ...(spec.redactInput === undefined ? {} : { redactInput: spec.redactInput }),
    execute: spec.execute,
  });
}
