import type { AccessModel } from "../core/access-model.js";
import type { DslPermissionTarget, DslRoleSlot } from "../core/dsl-types.js";
import type { PermissionToken, RoleToken } from "../core/refs.js";
import type { PermissionQuery, RelationshipWrite, SubjectRef } from "../runtime/authorization.js";
import {
  type AccessScenarioVerbs,
  type GrantBuilder,
  type HarnessEntityTarget,
  type HarnessSubjectInput,
  type MatrixDecision,
  type PermissionMatrixSpec,
  resolvePermissionTarget,
  resolveRoleTarget,
  resolveSubjectInput,
  resolveWireName,
  type RevokeBuilder,
} from "./access-harness-types.js";
import {
  buildMatrixFailureMessage,
  buildVisibleFailureMessage,
  type MatrixMismatch,
  validateMatrixSpec,
} from "./access-matrix.js";
import { type ControllableClock, parseTestDurationMs, type TestDuration } from "./duration.js";
import { formatPermissionTarget, formatSubjectRef } from "./explain-format.js";
import { InMemoryAuthorization, type InMemoryAuthorizationOptions } from "./in-memory-authorization.js";

/** Fully synchronous fluent authorization harness for zero-`await` unit tests. */
export type AccessHarness = AccessScenarioVerbs & {
  readonly authorization: InMemoryAuthorization;
  readonly clock: ControllableClock;
  readonly now: () => Date;
  readonly can: {
    (actor: SubjectRef, target: DslPermissionTarget): boolean;
    (actor: SubjectRef, permission: PermissionToken, resourceId: string): boolean;
  };
  readonly visible: (actor: SubjectRef, permission: PermissionToken) => readonly string[];
  readonly explain: {
    (actor: SubjectRef, target: DslPermissionTarget): string;
    (actor: SubjectRef, permission: PermissionToken, resourceId: string): string;
  };
};

function createGrantBuilder(
  authorization: InMemoryAuthorization,
  entityWireName: string,
  roleName: string,
  resourceId: string,
  expiresAt?: Date,
): GrantBuilder {
  return {
    expiringIn: (duration: TestDuration) =>
      createGrantBuilder(
        authorization,
        entityWireName,
        roleName,
        resourceId,
        new Date(authorization.now().getTime() + parseTestDurationMs(duration)),
      ),
    expiringAt: (nextExpiresAt: Date) =>
      createGrantBuilder(authorization, entityWireName, roleName, resourceId, nextExpiresAt),
    to: (first: HarnessSubjectInput | HarnessEntityTarget, secondId?: string) => {
      const subject = resolveSubjectInput(first, secondId);
      const write: RelationshipWrite =
        expiresAt === undefined
          ? {
              resource: { type: entityWireName, id: resourceId },
              relation: roleName,
              subject,
            }
          : {
              resource: { type: entityWireName, id: resourceId },
              relation: roleName,
              subject,
              expiresAt,
            };
      authorization.writeRelationshipsSync([write]);
    },
  };
}

function createRevokeBuilder(
  authorization: InMemoryAuthorization,
  entityWireName: string,
  roleName: string,
  resourceId: string,
): RevokeBuilder {
  return {
    from: (first: HarnessSubjectInput | HarnessEntityTarget, secondId?: string) => {
      const subject = resolveSubjectInput(first, secondId);
      authorization.deleteRelationshipsSync({
        resourceType: entityWireName,
        resourceId,
        relation: roleName,
        subject,
      });
    },
    all: () => {
      authorization.deleteRelationshipsSync({
        resourceType: entityWireName,
        resourceId,
        relation: roleName,
      });
    },
  };
}

function assertCheckSync(authorization: InMemoryAuthorization, query: PermissionQuery, expected: boolean): void {
  const actual = authorization.checkSync(query);
  if (actual === expected) return;
  const expectation = expected ? "HAVE" : "NOT have";
  const outcome = actual ? "ALLOWED" : "DENIED";
  throw new Error(
    [
      `Expected ${formatSubjectRef(query.subject)} to ${expectation} ${formatPermissionTarget(query)}, but it was ${outcome}.`,
      "",
      authorization.explainText(query),
    ].join("\n"),
  );
}

function assertVisibleSync(
  authorization: InMemoryAuthorization,
  actor: SubjectRef,
  permission: PermissionToken,
  expectedIds: readonly string[],
): void {
  const actualIds = [
    ...authorization.lookupResourcesSync({
      subject: actor,
      resourceType: permission.entityWireName,
      permission: permission.permissionName,
    }),
  ].sort();
  const sortedExpected = [...new Set(expectedIds)].sort();
  const matches =
    actualIds.length === sortedExpected.length && actualIds.every((id, index) => id === sortedExpected[index]);
  if (matches) return;
  throw new Error(
    buildVisibleFailureMessage({
      actor,
      resourceType: permission.entityWireName,
      permissionName: permission.permissionName,
      expectedIds: sortedExpected,
      actualIds,
      explain: (query) => authorization.explainText(query),
    }),
  );
}

function assertMatrixSync(
  authorization: InMemoryAuthorization,
  resourceType: string,
  resourceId: string,
  spec: PermissionMatrixSpec,
): void {
  validateMatrixSpec(spec);
  const actualGrid: MatrixDecision[][] = [];
  const mismatches: MatrixMismatch[] = [];

  for (const [actor, expectedRow] of spec.cases) {
    const actualRow: MatrixDecision[] = [];
    for (let columnIndex = 0; columnIndex < spec.permissions.length; columnIndex += 1) {
      const permission = spec.permissions[columnIndex];
      const expected = expectedRow[columnIndex] ?? "deny";
      if (permission === undefined) continue;
      const query: PermissionQuery = {
        subject: actor,
        resource: { type: resourceType, id: resourceId },
        permission: permission.permissionName,
      };
      const actual: MatrixDecision = authorization.checkSync(query) ? "allow" : "deny";
      actualRow.push(actual);
      if (actual !== expected) {
        mismatches.push({
          actor,
          permissionName: permission.permissionName,
          expected,
          actual,
          explanation: authorization.explainText(query),
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

function buildPermissionQuery(
  actor: SubjectRef,
  permissionOrTarget: PermissionToken | DslPermissionTarget,
  resourceId?: string,
): PermissionQuery {
  const target = resolvePermissionTarget(permissionOrTarget, resourceId);
  return {
    subject: actor,
    resource: { type: target.entityWireName, id: target.resourceId },
    permission: target.permissionName,
  };
}

function buildReadMethods(authorization: InMemoryAuthorization) {
  return {
    can: (actor: SubjectRef, permissionOrTarget: PermissionToken | DslPermissionTarget, resourceId?: string) =>
      authorization.checkSync(buildPermissionQuery(actor, permissionOrTarget, resourceId)),
    visible: (actor: SubjectRef, permission: PermissionToken) =>
      authorization.lookupResourcesSync({
        subject: actor,
        resourceType: permission.entityWireName,
        permission: permission.permissionName,
      }),
    explain: (actor: SubjectRef, permissionOrTarget: PermissionToken | DslPermissionTarget, resourceId?: string) =>
      authorization.explainText(buildPermissionQuery(actor, permissionOrTarget, resourceId)),
  };
}

function buildAssertMethods(authorization: InMemoryAuthorization) {
  return {
    assertCan: (actor: SubjectRef, permissionOrTarget: PermissionToken | DslPermissionTarget, resourceId?: string) => {
      assertCheckSync(authorization, buildPermissionQuery(actor, permissionOrTarget, resourceId), true);
    },
    assertCannot: (
      actor: SubjectRef,
      permissionOrTarget: PermissionToken | DslPermissionTarget,
      resourceId?: string,
    ) => {
      assertCheckSync(authorization, buildPermissionQuery(actor, permissionOrTarget, resourceId), false);
    },
    assertVisible: (actor: SubjectRef, permission: PermissionToken, expectedIds: readonly string[]) => {
      assertVisibleSync(authorization, actor, permission, expectedIds);
    },
    assertMatrix: (target: HarnessEntityTarget, resourceId: string, spec: PermissionMatrixSpec) => {
      assertMatrixSync(authorization, resolveWireName(target), resourceId, spec);
    },
  };
}

/**
 * Create a synchronous in-memory authorization harness for fast, zero-`await`
 * unit tests that execute the real compiled `AccessModel` policy.
 */
export function createAccessHarness(model: AccessModel, options?: InMemoryAuthorizationOptions): AccessHarness {
  const authorization = new InMemoryAuthorization(model, options);

  return {
    authorization,
    clock: authorization.getClock(),
    now: () => authorization.now(),
    actor: (target, id) => ({ type: resolveWireName(target), id }),
    members: (role, resourceId) => ({
      type: role.entityWireName,
      id: resourceId,
      relation: role.roleName,
    }),
    everyone: (target) => ({ type: resolveWireName(target), id: "*" }),
    grant: (roleOrSlot: RoleToken | DslRoleSlot, resourceId?: string) => {
      const target = resolveRoleTarget(roleOrSlot, resourceId);
      return createGrantBuilder(authorization, target.entityWireName, target.roleName, target.resourceId);
    },
    revoke: (roleOrSlot: RoleToken | DslRoleSlot, resourceId?: string) => {
      const target = resolveRoleTarget(roleOrSlot, resourceId);
      return createRevokeBuilder(authorization, target.entityWireName, target.roleName, target.resourceId);
    },
    advanceTime: (duration) => {
      authorization.advanceTime(duration);
    },
    setTime: (nextTime) => {
      authorization.setTime(nextTime);
    },
    ...buildReadMethods(authorization),
    ...buildAssertMethods(authorization),
  };
}
