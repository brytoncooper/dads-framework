import { z } from "zod";
import {
  activityResponse,
  artifactResponse,
  createRequestKey,
  memberResponse,
  resourceId,
  taskResponse,
  workspaceResponse,
} from "../contracts.js";
import { createRequestLimit } from "../operations/create-request.js";
import { workbenchTask, workbenchUser, workbenchWorkspace } from "../access.js";

const userSubject = z.strictObject({
  type: z.literal(workbenchUser.wireName),
  id: resourceId,
});
const workspaceSubject = z.strictObject({
  type: z.literal(workbenchWorkspace.wireName),
  id: resourceId,
});
const relationship = z.union([
  z.strictObject({
    subject: userSubject,
    relation: z.enum([
      workbenchWorkspace.roles.owner.roleName,
      workbenchWorkspace.roles.member.roleName,
    ]),
    resource: z.strictObject({
      type: z.literal(workbenchWorkspace.wireName),
      id: resourceId,
    }),
  }),
  z.strictObject({
    subject: workspaceSubject,
    relation: z.literal(workbenchTask.roles.workspace.roleName),
    resource: z.strictObject({
      type: z.literal(workbenchTask.wireName),
      id: resourceId,
    }),
  }),
]);
export const pendingAuthorizationChange = z
  .strictObject({
    version: z.literal(1),
    operationId: resourceId,
    writes: z.array(relationship),
    deletes: z.array(relationship),
  })
  .refine((change) => change.writes.length > 0 || change.deletes.length > 0, {
    message: "A pending authorization change must contain durable intent.",
  });
const createRequestRecord = z.strictObject({
  subjectType: resourceId,
  subjectId: resourceId,
  operation: z.enum(["createWorkspace", "createTask", "createArtifact"]),
  parentId: resourceId.nullable(),
  requestKey: createRequestKey,
  payload: z.tuple([z.string().max(8_192), z.string().max(8_192)]),
  resourceId,
});
export type CreateRequestRecord = z.infer<typeof createRequestRecord>;
export const workbenchState = z.strictObject({
  schemaVersion: z.literal(1),
  workspaces: z.array(workspaceResponse),
  tasks: z.array(taskResponse),
  members: z.array(memberResponse),
  artifacts: z.array(artifactResponse),
  activity: z.array(activityResponse),
  pendingAuthorizationChanges: z.array(pendingAuthorizationChange),
  createRequests: z
    .array(createRequestRecord)
    .max(createRequestLimit)
    .default([]),
});
export type WorkbenchState = z.infer<typeof workbenchState>;
export type PendingAuthorizationChange = z.infer<
  typeof pendingAuthorizationChange
>;
export type StoredWorkbenchRelationship = z.infer<typeof relationship>;

export function storeWorkbenchAuthorizationChange(
  change: PendingAuthorizationChange,
): PendingAuthorizationChange {
  return pendingAuthorizationChange.parse(change);
}

export function emptyWorkbenchState(): WorkbenchState {
  return {
    schemaVersion: 1,
    workspaces: [],
    tasks: [],
    members: [],
    artifacts: [],
    activity: [],
    pendingAuthorizationChanges: [],
    createRequests: [],
  };
}
