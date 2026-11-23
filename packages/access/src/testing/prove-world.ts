import type { AccessModel } from "../core/access-model.js";
import { permissionToken } from "../core/refs.js";
import type { AccessWorld } from "../core/world.js";
import type { PermissionQuery, RelationshipWrite, SubjectRef } from "../runtime/authorization.js";
import type { AccessScenarioVerbs, ProveAccessOptions, ScenarioStep } from "./access-harness-types.js";
import { createAccessHarness } from "./access-harness.js";
import { ControllableClock, parseTestDurationMs } from "./duration.js";
import { formatPermissionTarget, formatSubjectRef } from "./explain-format.js";
import { InMemoryAuthorization } from "./in-memory-authorization.js";
import { executeRecordedSteps, recordScenarioSteps } from "./prove-access.js";

/** A reusable, backend-agnostic authorization scenario with grants, revocations, time travel, and assertions. */
export type AccessScenario = {
  readonly title: string;
  readonly steps: readonly ScenarioStep[];
};

export type ComposableScenarioVerbs = AccessScenarioVerbs & {
  readonly include: (other: AccessScenario) => void;
};

function parseSubjectString(rawSubject: string): SubjectRef {
  const hashIndex = rawSubject.indexOf("#");
  const objectPart = hashIndex === -1 ? rawSubject : rawSubject.slice(0, hashIndex);
  const relation = hashIndex === -1 ? undefined : rawSubject.slice(hashIndex + 1);
  const colonIndex = objectPart.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(`Invalid subject tuple segment "${rawSubject}"`);
  }
  const type = objectPart.slice(0, colonIndex);
  const id = objectPart.slice(colonIndex + 1);
  return relation === undefined ? { type, id } : { type, id, relation };
}

function parseTupleString(rawTuple: string): {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly name: string;
  readonly subject: SubjectRef;
} {
  const atIndex = rawTuple.indexOf("@");
  if (atIndex === -1) {
    throw new Error(`Invalid tuple "${rawTuple}": missing "@" separator`);
  }
  const leftSide = rawTuple.slice(0, atIndex);
  const rightSide = rawTuple.slice(atIndex + 1);
  const hashIndex = leftSide.indexOf("#");
  if (hashIndex === -1) {
    throw new Error(`Invalid tuple "${rawTuple}": missing "#" relation`);
  }
  const resourcePart = leftSide.slice(0, hashIndex);
  const name = leftSide.slice(hashIndex + 1);
  const colonIndex = resourcePart.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(`Invalid tuple "${rawTuple}": missing ":" resource type`);
  }
  return {
    resourceType: resourcePart.slice(0, colonIndex),
    resourceId: resourcePart.slice(colonIndex + 1),
    name,
    subject: parseSubjectString(rightSide),
  };
}

function worldToWritesAndChecks(scenarioWorld: AccessWorld): {
  readonly writes: readonly RelationshipWrite[];
  readonly checks: readonly {
    readonly query: PermissionQuery;
    readonly expected: boolean;
  }[];
} {
  const writes: RelationshipWrite[] = scenarioWorld.relationships.map((rawTuple) => {
    const parsed = parseTupleString(rawTuple);
    return {
      resource: { type: parsed.resourceType, id: parsed.resourceId },
      relation: parsed.name,
      subject: parsed.subject,
    };
  });
  const checks: {
    readonly query: PermissionQuery;
    readonly expected: boolean;
  }[] = [];
  for (const rawAllow of scenarioWorld.assertions.true) {
    const parsed = parseTupleString(rawAllow);
    checks.push({
      query: {
        resource: { type: parsed.resourceType, id: parsed.resourceId },
        permission: parsed.name,
        subject: parsed.subject,
      },
      expected: true,
    });
  }
  for (const rawDeny of scenarioWorld.assertions.false) {
    const parsed = parseTupleString(rawDeny);
    checks.push({
      query: {
        resource: { type: parsed.resourceType, id: parsed.resourceId },
        permission: parsed.name,
        subject: parsed.subject,
      },
      expected: false,
    });
  }
  return { writes, checks };
}

function throwWorldCheckFailure(
  title: string,
  explainer: InMemoryAuthorization,
  query: PermissionQuery,
  expected: boolean,
  actual: boolean,
): never {
  const expectation = expected ? "HAVE" : "NOT have";
  const outcome = actual ? "ALLOWED" : "DENIED";
  throw new Error(
    [
      `World "${title}" failed: expected ${formatSubjectRef(query.subject)} to ${expectation} ${formatPermissionTarget(query)}, but it was ${outcome}.`,
      "",
      explainer.explainText(query),
    ].join("\n"),
  );
}

/**
 * Synchronously execute an `AccessWorld` authored with `world()` against the
 * real compiled `AccessModel` in memory (zero `await`s).
 */
export function proveWorldSync(model: AccessModel, scenarioWorld: AccessWorld): void {
  const { writes, checks } = worldToWritesAndChecks(scenarioWorld);
  const authorization = new InMemoryAuthorization(model);
  authorization.writeRelationshipsSync(writes);

  for (const checkItem of checks) {
    const actual = authorization.checkSync(checkItem.query);
    if (actual !== checkItem.expected) {
      throwWorldCheckFailure(scenarioWorld.title, authorization, checkItem.query, checkItem.expected, actual);
    }
  }
}

/**
 * Execute an `AccessWorld` against any `Authorization` backend (Postgres,
 * SQLite, or in-memory by default) under a single `await`.
 */
export async function proveWorld(
  model: AccessModel,
  scenarioWorld: AccessWorld,
  options?: ProveAccessOptions,
): Promise<void> {
  const { writes, checks } = worldToWritesAndChecks(scenarioWorld);
  const clock = options?.clock ?? new ControllableClock(options?.startTime);
  const explainer = new InMemoryAuthorization(model, { clock });
  const authorization = options?.authorization ?? explainer;

  if (writes.length > 0) {
    await authorization.writeRelationships(writes);
    if (authorization !== explainer) explainer.writeRelationshipsSync(writes);
  }

  for (const checkItem of checks) {
    const actual = await authorization.check(checkItem.query);
    if (actual !== checkItem.expected) {
      throwWorldCheckFailure(scenarioWorld.title, explainer, checkItem.query, checkItem.expected, actual);
    }
  }
}

/**
 * Author a reusable, composable authorization scenario once and run it on
 * pure-TS in-memory, SQLite, or Postgres backends.
 */
export function defineAccessScenario(
  title: string,
  build: (scenario: ComposableScenarioVerbs) => void,
): AccessScenario {
  const steps = recordScenarioSteps((baseVerbs, appendSteps) => {
    const composable: ComposableScenarioVerbs = {
      ...baseVerbs,
      include: (other) => {
        appendSteps(other.steps);
      },
    };
    build(composable);
  });
  return { title, steps };
}

function runSyncGrantStep(
  harness: ReturnType<typeof createAccessHarness>,
  step: Extract<ScenarioStep, { readonly kind: "grant" }>,
): void {
  const write: RelationshipWrite =
    step.expiresIn === undefined
      ? step.write
      : {
          ...step.write,
          expiresAt: new Date(harness.clock.nowMs() + parseTestDurationMs(step.expiresIn)),
        };
  harness.authorization.writeRelationshipsSync([write]);
}

function runSyncCheckStep(
  harness: ReturnType<typeof createAccessHarness>,
  step: Extract<ScenarioStep, { readonly kind: "assert-check" }>,
): void {
  const permission = permissionToken(step.query.resource.type, step.query.permission);
  if (step.expected) {
    harness.assertCan(step.query.subject, permission, step.query.resource.id);
    return;
  }
  harness.assertCannot(step.query.subject, permission, step.query.resource.id);
}

function runScenarioStepSync(harness: ReturnType<typeof createAccessHarness>, step: ScenarioStep): void {
  if (step.kind === "grant") {
    runSyncGrantStep(harness, step);
    return;
  }
  if (step.kind === "revoke") {
    harness.authorization.deleteRelationshipsSync(step.filter);
    return;
  }
  if (step.kind === "advance-time") {
    harness.advanceTime(step.duration);
    return;
  }
  if (step.kind === "set-time") {
    harness.setTime(step.time);
    return;
  }
  if (step.kind === "assert-check") {
    runSyncCheckStep(harness, step);
    return;
  }
  if (step.kind === "assert-visible") {
    harness.assertVisible(step.actor, step.permission, step.expectedIds);
    return;
  }
  harness.assertMatrix({ wireName: step.resourceType }, step.resourceId, step.spec);
}

/** Synchronously execute a reusable `AccessScenario` in memory (zero `await`s). */
export function proveScenarioSync(
  model: AccessModel,
  scenario: AccessScenario,
  options?: { readonly startTime?: Date | number },
): void {
  const harness = createAccessHarness(model, options);
  for (const step of scenario.steps) {
    runScenarioStepSync(harness, step);
  }
}

/** Execute a reusable `AccessScenario` against any `Authorization` backend under one `await`. */
export async function proveScenario(
  model: AccessModel,
  scenario: AccessScenario,
  options?: ProveAccessOptions,
): Promise<void> {
  await executeRecordedSteps(model, scenario.steps, options);
}
