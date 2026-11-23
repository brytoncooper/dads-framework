import { mintUuidV7 } from "@dads-framework/core/contract";
import { notFound, validation } from "@dads-framework/core/errors";

import type { LiveActionCaller, LiveActionDefinition } from "./live-action.js";
import type { LiveActionRunRecord, LiveActionRunStore } from "./live-action-run-store.js";
import { redactActionInput } from "./redact-input.js";

export type LiveActionExecutionAuthorizer<TInput = unknown> = (input: {
  readonly caller: LiveActionCaller;
  readonly action: LiveActionDefinition<TInput>;
}) => Promise<boolean>;

export type ExecuteLiveActionOptions<TInput = unknown> = {
  readonly action: LiveActionDefinition<TInput>;
  readonly caller: LiveActionCaller;
  readonly reason: string;
  readonly input: unknown;
  readonly store: LiveActionRunStore;
  readonly canExecute: LiveActionExecutionAuthorizer<TInput>;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  /** Optional sanitizer for error text persisted to `errorMessage` on failure. */
  readonly redactError?: (error: unknown) => string;
};

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Authorize, validate, audit, and execute a live operational action.
 *
 * Authorization runs before input parsing so unauthorized callers cannot probe
 * action schemas. A `"running"` audit row with redacted input is persisted
 * before `action.execute` runs, and the row is finalized as `"succeeded"` or
 * `"failed"` with `finishedAt` once execution settles.
 */
export async function executeLiveAction<TInput>(
  options: ExecuteLiveActionOptions<TInput>,
): Promise<LiveActionRunRecord> {
  const allowed = await options.canExecute({ caller: options.caller, action: options.action });
  if (!allowed) {
    throw notFound("LIVE_ACTION_NOT_FOUND", "Live action not found");
  }

  const parsed = options.action.inputSchema.safeParse(options.input);
  if (!parsed.success) {
    throw validation("LIVE_ACTION_INVALID_INPUT", "Live action input failed validation", {
      issues: parsed.error.issues,
    });
  }

  const clock = options.now ?? (() => new Date());
  const startedAt = clock();
  const runId = mintUuidV7(startedAt.getTime());
  const redactedInput = redactActionInput(
    parsed.data,
    options.action.redactInput === undefined ? undefined : (value) => options.action.redactInput?.(value),
  );

  const initialRecord: LiveActionRunRecord = {
    id: runId,
    actionName: options.action.name,
    dangerLevel: options.action.dangerLevel,
    actorType: options.caller.type,
    actorId: options.caller.id,
    reason: options.reason,
    redactedInput,
    outcome: "running",
    summary: null,
    errorMessage: null,
    startedAt,
    finishedAt: null,
  };
  await options.store.recordStart(initialRecord);

  return runAndFinalize(options, parsed.data, initialRecord, clock);
}

async function runAndFinalize<TInput>(
  options: ExecuteLiveActionOptions<TInput>,
  parsedInput: TInput,
  initialRecord: LiveActionRunRecord,
  clock: () => Date,
): Promise<LiveActionRunRecord> {
  try {
    const result = await options.action.execute({
      input: parsedInput,
      caller: options.caller,
      reason: options.reason,
      runId: initialRecord.id,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const finishedAt = clock();
    await options.store.recordFinish({
      id: initialRecord.id,
      outcome: "succeeded",
      summary: result.summary,
      errorMessage: null,
      finishedAt,
    });
    return {
      ...initialRecord,
      outcome: "succeeded",
      summary: result.summary,
      errorMessage: null,
      finishedAt,
    };
  } catch (error: unknown) {
    const finishedAt = clock();
    const redactError = options.redactError ?? options.action.redactError ?? formatErrorMessage;
    const errorMessage = redactError(error);
    await options.store.recordFinish({
      id: initialRecord.id,
      outcome: "failed",
      summary: null,
      errorMessage,
      finishedAt,
    });
    return {
      ...initialRecord,
      outcome: "failed",
      summary: null,
      errorMessage,
      finishedAt,
    };
  }
}
