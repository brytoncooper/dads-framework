import type { AccessModel } from "../core/access-model.js";
import type { PermissionToken } from "../core/refs.js";
import type {
  Authorization,
  PermissionQuery,
  RelationshipWrite,
  SubjectRef,
} from "../runtime/authorization.js";
import type {
  AccessScenarioVerbs,
  MatrixDecision,
  PermissionMatrixSpec,
  ProveAccessOptions,
  ScenarioStep,
} from "./access-harness-types.js";
import {
  buildMatrixFailureMessage,
  buildVisibleFailureMessage,
  type MatrixMismatch,
  validateMatrixSpec,
} from "./access-matrix.js";
import { ControllableClock, parseTestDurationMs } from "./duration.js";
import { formatPermissionTarget, formatSubjectRef } from "./explain-format.js";
import { InMemoryAuthorization } from "./in-memory-authorization.js";
import { recordScenarioSteps } from "./record-scenario-steps.js";

export { recordScenarioSteps };

async function executeMatrixStep(
  authorization: Authorization,
  explainer: InMemoryAuthorization,
  resourceType: string,
  resourceId: string,
  spec: PermissionMatrixSpec,
): Promise<void> {
  validateMatrixSpec(spec);
  const actualGrid: MatrixDecision[][] = [];
  const mismatches: MatrixMismatch[] = [];

  for (const [actor, expectedRow] of spec.cases) {
    const actualRow: MatrixDecision[] = [];
    for (
      let columnIndex = 0;
      columnIndex < spec.permissions.length;
      columnIndex += 1
    ) {
      const permission = spec.permissions[columnIndex];
      const expected = expectedRow[columnIndex] ?? "deny";
      if (permission === undefined) continue;
      const query: PermissionQuery = {
        subject: actor,
        resource: { type: resourceType, id: resourceId },
        permission: permission.permissionName,
      };
      const actual: MatrixDecision = (await authorization.check(query))
        ? "allow"
        : "deny";
      actualRow.push(actual);
      if (actual !== expected) {
        mismatches.push({
          actor,
          permissionName: permission.permissionName,
          expected,
          actual,
          explanation: explainer.explainText(query),
        });
      }
    }
    actualGrid.push(actualRow);
  }

  if (mismatches.length > 0) {
    throw new Error(
      buildMatrixFailureMessage({
        resourceType,
        resourceId,
        spec,
        actualGrid,
        mismatches,
      }),
    );
  }
}

async function executeAssertCheck(
  authorization: Authorization,
  explainer: InMemoryAuthorization,
  query: PermissionQuery,
  expected: boolean,
): Promise<void> {
  const actual = await authorization.check(query);
  if (actual === expected) return;
  const expectation = expected ? "HAVE" : "NOT have";
  const outcome = actual ? "ALLOWED" : "DENIED";
  throw new Error(
    [
      `Expected ${formatSubjectRef(query.subject)} to ${expectation} ${formatPermissionTarget(query)}, but it was ${outcome}.`,
      "",
      explainer.explainText(query),
    ].join("\n"),
  );
}

async function executeAssertVisible(
  authorization: Authorization,
  explainer: InMemoryAuthorization,
  actor: SubjectRef,
  permission: PermissionToken,
  expectedIds: readonly string[],
): Promise<void> {
  const actualIds = [
    ...(await authorization.lookupResources({
      subject: actor,
      resourceType: permission.entityWireName,
      permission: permission.permissionName,
    })),
  ].sort();
  const sortedExpected = [...new Set(expectedIds)].sort();
  const matches =
    actualIds.length === sortedExpected.length &&
    actualIds.every((id, index) => id === sortedExpected[index]);
  if (matches) return;
  throw new Error(
    buildVisibleFailureMessage({
      actor,
      resourceType: permission.entityWireName,
      permissionName: permission.permissionName,
      expectedIds: sortedExpected,
      actualIds,
      explain: (query) => explainer.explainText(query),
    }),
  );
}

async function executeGrantStep(
  step: Extract<ScenarioStep, { readonly kind: "grant" }>,
  authorization: Authorization,
  explainer: InMemoryAuthorization,
  clock: ControllableClock,
): Promise<void> {
  const write: RelationshipWrite =
    step.expiresIn === undefined
      ? step.write
      : {
          ...step.write,
          expiresAt: new Date(
            clock.nowMs() + parseTestDurationMs(step.expiresIn),
          ),
        };
  await authorization.writeRelationships([write]);
  if (authorization !== explainer) explainer.writeRelationshipsSync([write]);
}

function executeClockStep(
  step: Extract<ScenarioStep, { readonly kind: "advance-time" | "set-time" }>,
  authorization: Authorization,
  explainer: InMemoryAuthorization,
  clock: ControllableClock,
  isExternalClock: boolean,
): void {
  if (!isExternalClock && authorization !== explainer) {
    throw new Error(
      `${step.kind === "advance-time" ? "advanceTime" : "setTime"}() requires options.clock when running against an external authorization backend.`,
    );
  }
  if (step.kind === "advance-time") clock.advance(step.duration);
  else clock.set(step.time);
}

async function executeStep(
  step: ScenarioStep,
  authorization: Authorization,
  explainer: InMemoryAuthorization,
  clock: ControllableClock,
  isExternalClock: boolean,
): Promise<void> {
  if (step.kind === "grant") {
    await executeGrantStep(step, authorization, explainer, clock);
    return;
  }
  if (step.kind === "revoke") {
    await authorization.deleteRelationships(step.filter);
    if (authorization !== explainer) {
      explainer.deleteRelationshipsSync(step.filter);
    }
    return;
  }
  if (step.kind === "advance-time" || step.kind === "set-time") {
    executeClockStep(step, authorization, explainer, clock, isExternalClock);
    return;
  }
  if (step.kind === "assert-check") {
    await executeAssertCheck(
      authorization,
      explainer,
      step.query,
      step.expected,
    );
    return;
  }
  if (step.kind === "assert-visible") {
    await executeAssertVisible(
      authorization,
      explainer,
      step.actor,
      step.permission,
      step.expectedIds,
    );
    return;
  }
  await executeMatrixStep(
    authorization,
    explainer,
    step.resourceType,
    step.resourceId,
    step.spec,
  );
}

/** Execute pre-recorded scenario steps against any `Authorization` backend. */
export async function executeRecordedSteps(
  model: AccessModel,
  steps: readonly ScenarioStep[],
  options: ProveAccessOptions = {},
): Promise<void> {
  const hasExternalClock = options.clock !== undefined;
  const clock =
    options.clock ??
    new ControllableClock(
      options.startTime ??
        (options.authorization === undefined ? undefined : Date.now()),
    );
  const explainer = new InMemoryAuthorization(model, { clock });
  const authorization = options.authorization ?? explainer;

  for (const step of steps) {
    await executeStep(step, authorization, explainer, clock, hasExternalClock);
  }
}

/**
 * Execute a recorded authorization scenario against any `Authorization` backend
 * (Postgres, SQLite, or in-memory by default) under a single `await`.
 */
export async function proveAccess(
  model: AccessModel,
  options: ProveAccessOptions,
  build: (scenario: AccessScenarioVerbs) => void,
): Promise<void> {
  const steps = recordScenarioSteps((scenario) => {
    build(scenario);
  });
  await executeRecordedSteps(model, steps, options);
}
