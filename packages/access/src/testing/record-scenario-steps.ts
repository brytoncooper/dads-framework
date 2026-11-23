import type { DslPermissionTarget, DslRoleSlot } from "../core/dsl-types.js";
import type { PermissionToken, RoleToken } from "../core/refs.js";
import type { RelationshipWrite, SubjectRef } from "../runtime/authorization.js";
import {
  type AccessScenarioVerbs,
  type GrantBuilder,
  type HarnessEntityTarget,
  type HarnessSubjectInput,
  type PermissionMatrixSpec,
  resolvePermissionTarget,
  resolveRoleTarget,
  resolveSubjectInput,
  resolveWireName,
  type RevokeBuilder,
  type ScenarioStep,
} from "./access-harness-types.js";
import type { TestDuration } from "./duration.js";

function createRecordingGrantBuilder(
  steps: ScenarioStep[],
  entityWireName: string,
  roleName: string,
  resourceId: string,
  expiration:
    | { readonly kind: "none" }
    | { readonly kind: "relative"; readonly duration: TestDuration }
    | { readonly kind: "absolute"; readonly expiresAt: Date } = {
    kind: "none",
  },
): GrantBuilder {
  return {
    expiringIn: (duration: TestDuration) =>
      createRecordingGrantBuilder(steps, entityWireName, roleName, resourceId, {
        kind: "relative",
        duration,
      }),
    expiringAt: (expiresAt: Date) =>
      createRecordingGrantBuilder(steps, entityWireName, roleName, resourceId, {
        kind: "absolute",
        expiresAt,
      }),
    to: (first: HarnessSubjectInput | HarnessEntityTarget, secondId?: string) => {
      const subject = resolveSubjectInput(first, secondId);
      const baseWrite: RelationshipWrite = {
        resource: { type: entityWireName, id: resourceId },
        relation: roleName,
        subject,
      };
      if (expiration.kind === "absolute") {
        steps.push({
          kind: "grant",
          write: { ...baseWrite, expiresAt: expiration.expiresAt },
        });
        return;
      }
      if (expiration.kind === "relative") {
        steps.push({
          kind: "grant",
          write: baseWrite,
          expiresIn: expiration.duration,
        });
        return;
      }
      steps.push({ kind: "grant", write: baseWrite });
    },
  };
}

function createRecordingRevokeBuilder(
  steps: ScenarioStep[],
  entityWireName: string,
  roleName: string,
  resourceId: string,
): RevokeBuilder {
  return {
    from: (first: HarnessSubjectInput | HarnessEntityTarget, secondId?: string) => {
      const subject = resolveSubjectInput(first, secondId);
      steps.push({
        kind: "revoke",
        filter: {
          resourceType: entityWireName,
          resourceId,
          relation: roleName,
          subject,
        },
      });
    },
    all: () => {
      steps.push({
        kind: "revoke",
        filter: {
          resourceType: entityWireName,
          resourceId,
          relation: roleName,
        },
      });
    },
  };
}

function buildScenarioAssertVerbs(steps: ScenarioStep[]) {
  const pushCheck = (
    actor: SubjectRef,
    permissionOrTarget: PermissionToken | DslPermissionTarget,
    resourceId: string | undefined,
    expected: boolean,
  ) => {
    const target = resolvePermissionTarget(permissionOrTarget, resourceId);
    steps.push({
      kind: "assert-check",
      query: {
        subject: actor,
        resource: { type: target.entityWireName, id: target.resourceId },
        permission: target.permissionName,
      },
      expected,
    });
  };
  return {
    assertCan: (actor: SubjectRef, permissionOrTarget: PermissionToken | DslPermissionTarget, resourceId?: string) => {
      pushCheck(actor, permissionOrTarget, resourceId, true);
    },
    assertCannot: (
      actor: SubjectRef,
      permissionOrTarget: PermissionToken | DslPermissionTarget,
      resourceId?: string,
    ) => {
      pushCheck(actor, permissionOrTarget, resourceId, false);
    },
    assertVisible: (actor: SubjectRef, permission: PermissionToken, expectedIds: readonly string[]) => {
      steps.push({ kind: "assert-visible", actor, permission, expectedIds });
    },
    assertMatrix: (target: HarnessEntityTarget, resourceId: string, spec: PermissionMatrixSpec) => {
      steps.push({
        kind: "assert-matrix",
        resourceType: resolveWireName(target),
        resourceId,
        spec,
      });
    },
  };
}

/** Synchronously record scenario steps with zero `await`s inside the callback. */
export function recordScenarioSteps(
  build: (scenario: AccessScenarioVerbs, appendSteps: (extraSteps: readonly ScenarioStep[]) => void) => void,
): readonly ScenarioStep[] {
  const steps: ScenarioStep[] = [];
  const scenario: AccessScenarioVerbs = {
    actor: (target, id) => ({ type: resolveWireName(target), id }),
    members: (role, resourceId) => ({
      type: role.entityWireName,
      id: resourceId,
      relation: role.roleName,
    }),
    everyone: (target) => ({ type: resolveWireName(target), id: "*" }),
    grant: (roleOrSlot: RoleToken | DslRoleSlot, resourceId?: string) => {
      const target = resolveRoleTarget(roleOrSlot, resourceId);
      return createRecordingGrantBuilder(steps, target.entityWireName, target.roleName, target.resourceId);
    },
    revoke: (roleOrSlot: RoleToken | DslRoleSlot, resourceId?: string) => {
      const target = resolveRoleTarget(roleOrSlot, resourceId);
      return createRecordingRevokeBuilder(steps, target.entityWireName, target.roleName, target.resourceId);
    },
    advanceTime: (duration) => {
      steps.push({ kind: "advance-time", duration });
    },
    setTime: (time) => {
      steps.push({ kind: "set-time", time });
    },
    ...buildScenarioAssertVerbs(steps),
  };

  build(scenario, (extraSteps) => {
    steps.push(...extraSteps);
  });
  return steps;
}
