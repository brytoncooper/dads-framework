import {
  paginationMetaSchema,
  paginationQuerySchema,
} from "@dads-framework/contract";
import { z } from "zod";

export const resourceId = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const name = z.string().trim().min(1).max(120);
const description = z.string().trim().min(0).max(2_000);
const timestamp = z.iso.datetime({ offset: true });
export const createRequestKey = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .describe(
    "Caller-generated key for one creation attempt. Reuse it with the same payload when retrying.",
  );
export const taskStatus = z.enum(["todo", "in_progress", "done"]);

export const workspaceParams = z.strictObject({ workspaceId: resourceId });
export const taskParams = z.strictObject({ taskId: resourceId });
export const memberParams = z.strictObject({
  workspaceId: resourceId,
  userId: resourceId,
});
export const listQuery = paginationQuerySchema;
export const listMeta = paginationMetaSchema.extend({
  pageCount: z.number().int().nonnegative().default(0),
});

export const createWorkspaceBody = z.strictObject({
  requestKey: createRequestKey,
  name,
  description: description.default(""),
});
export const updateWorkspaceBody = z
  .strictObject({ name, description })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "PATCH_REQUIRES_CHANGE");
export const workspaceResponse = z.object({
  id: resourceId,
  name,
  description,
  ownerId: resourceId,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const createTaskBody = z.strictObject({
  requestKey: createRequestKey,
  title: name,
  description: description.default(""),
});
export const updateTaskBody = z
  .strictObject({ title: name, description, status: taskStatus })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "PATCH_REQUIRES_CHANGE");
export const claimTaskBody = z.strictObject({});
export const taskResponse = z.object({
  id: resourceId,
  workspaceId: resourceId,
  title: name,
  description,
  status: taskStatus,
  claimedBy: resourceId.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const grantMemberBody = z.strictObject({ userId: resourceId });
export const memberResponse = z.object({
  workspaceId: resourceId,
  userId: resourceId,
  role: z.enum(["owner", "member"]),
  createdAt: timestamp,
});
export const createArtifactBody = z.strictObject({
  requestKey: createRequestKey,
  name,
  content: z.string().min(1).max(8_192),
});
export const artifactResponse = z.object({
  id: resourceId,
  workspaceId: resourceId,
  taskId: resourceId,
  name,
  content: z.string().min(1).max(8_192),
  createdBy: resourceId,
  createdAt: timestamp,
});
export const activityResponse = z.object({
  id: resourceId,
  workspaceId: resourceId,
  actorId: resourceId,
  resourceId,
  action: z.enum([
    "workspace.created",
    "workspace.updated",
    "task.created",
    "task.updated",
    "task.deleted",
    "task.claimed",
    "member.granted",
    "member.revoked",
    "artifact.created",
  ]),
  createdAt: timestamp,
});

export const resourceNotFound = {
  code: "RESOURCE_NOT_FOUND",
  status: 404,
  description: "The resource is absent or inaccessible.",
  defaultMessage: "The resource was not found.",
} as const;
export const workbenchConflict = {
  code: "WORKBENCH_CONFLICT",
  status: 409,
  description: "The requested change conflicts with current workbench state.",
  defaultMessage: "The requested change conflicts with current state.",
} as const;
export const postgresWriteConflict = {
  code: "POSTGRES_CONFLICT",
  status: 409,
  description:
    "The database aborted the write because it overlapped another transaction.",
  defaultMessage:
    "A concurrent change interrupted the operation. Refresh state before trying again.",
} as const;
export const relationshipsPending = {
  code: "RELATIONSHIPS_PENDING",
  status: 503,
  description:
    "A durable relationship change is awaiting the authorization service.",
  defaultMessage:
    "Authorization changes are pending. For creation, retry with the same requestKey and payload. For other changes, refresh state after recovery before deciding whether to retry.",
} as const;
export const authorizationUnavailable = {
  code: "AUTHORIZATION_UNAVAILABLE",
  status: 503,
  description:
    "The authorization service could not complete the required access evaluation.",
  defaultMessage: "Authorization is temporarily unavailable.",
} as const;

export type Workspace = z.infer<typeof workspaceResponse>;
export type Task = z.infer<typeof taskResponse>;
export type Member = z.infer<typeof memberResponse>;
export type Artifact = z.infer<typeof artifactResponse>;
export type Activity = z.infer<typeof activityResponse>;
export type CreateWorkspace = z.infer<typeof createWorkspaceBody>;
export type UpdateWorkspace = z.infer<typeof updateWorkspaceBody>;
export type CreateTask = z.infer<typeof createTaskBody>;
export type UpdateTask = z.infer<typeof updateTaskBody>;
export type CreateArtifact = z.infer<typeof createArtifactBody>;
export type ListQuery = z.infer<typeof listQuery>;
