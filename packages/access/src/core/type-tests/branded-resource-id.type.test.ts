/**
 * Compile-time contract proofs for branded resource IDs on `resource()`,
 * inline `children`, and `.child()`.
 * Every @ts-expect-error assertion is checked by `tsc -p packages/access/tsconfig.tests.json`.
 */
import { entityIdSchema, mintEntityId } from "@dads-framework/core/contract";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  actor,
  compileAccess,
  resource,
  type ActorRef,
  type DslPermissionTarget,
  type DslRoleSlot,
  type ResourceSubjectRef,
} from "../../index.js";
import { createAccessClient } from "../../runtime/index.js";
import { FakeAuthorization } from "../../runtime/fake-authorization.js";

const workspaceIdSchema = entityIdSchema("WorkspaceId", "Workspace identifier");
const projectIdSchema = entityIdSchema("ProjectId", "Project identifier");
const taskIdSchema = entityIdSchema("TaskId", "Task identifier");
const commentIdSchema = entityIdSchema("CommentId", "Comment identifier");
const folderIdSchema = entityIdSchema("FolderId", "Folder identifier");

type WorkspaceId = z.output<typeof workspaceIdSchema>;
type ProjectId = z.output<typeof projectIdSchema>;
type TaskId = z.output<typeof taskIdSchema>;
type CommentId = z.output<typeof commentIdSchema>;

describe("branded resource IDs", () => {
  it("enforces branded IDs on root resources, inline children, and .child() while keeping unbranded resources working", () => {
    const user = actor("user");

    const workspace = resource("workspace", {
      id: workspaceIdSchema,
      roles: {
        owner: user,
        member: user,
      },
      can: ({ owner, member }) => ({
        manage: owner,
        view: [owner, member],
      }),
      children: {
        audit_log: {
          inherit: ["view"],
        },
      },
    });

    const project = resource("project", {
      id: projectIdSchema,
      roles: {
        workspace,
        maintainer: user,
      },
      can: ({ workspace: ws, maintainer }) => ({
        edit: [ws.manage, maintainer],
        view: [ws.view, maintainer],
      }),
      children: {
        task: {
          id: taskIdSchema,
          inherit: "all",
          roles: { assignee: user },
          can: ({ assignee, parent }) => ({
            edit: [parent.edit, assignee],
          }),
          children: {
            comment: {
              id: commentIdSchema,
              inherit: ["view"],
              roles: { author: user },
              can: ({ author }) => ({
                edit: author,
              }),
            },
          },
        },
      },
    });

    const milestone = project.child("milestone", {
      id: taskIdSchema,
      inherit: "all",
      roles: { lead: user },
      can: ({ lead, parent }) => ({
        edit: [parent.edit, lead],
      }),
    });

    const note = resource("note", {
      roles: { author: user },
      can: ({ author }) => ({
        view: author,
        edit: author,
      }),
    });

    const folder = resource("folder", {
      id: folderIdSchema,
      recursive: true,
      roles: { editor: user },
      can: ({ editor }) => ({
        edit: editor,
        view: editor,
      }),
    });

    const unbrandedChild = workspace.child("workspace_setting", {
      inherit: ["view"],
    });

    const document = resource("document", {
      parents: [workspace, folder],
      roles: { author: user },
      can: ({ author, parents }) => ({
        view: [author, parents.view],
      }),
    });

    const customIdSchema = z.string().min(1).brand<"CustomTokenId">();
    type CustomTokenId = z.output<typeof customIdSchema>;
    const customToken = resource("custom_token", {
      id: customIdSchema,
      roles: { owner: user },
      can: ({ owner }) => ({ view: owner }),
    });

    const workspaceId = mintEntityId(workspaceIdSchema);
    const projectId = mintEntityId(projectIdSchema);
    const taskId = mintEntityId(taskIdSchema);
    const commentId = mintEntityId(commentIdSchema);
    const parentFolderId = mintEntityId(folderIdSchema);
    const childFolderId = mintEntityId(folderIdSchema);
    const customTokenId = customIdSchema.parse("tok_123");

    // Positive compile-time proofs for branded instances, slots, targets, and refs.
    const workspaceRef = workspace(workspaceId);
    const projectRef = project(projectId);
    const inlineTaskRef = project.task(taskId);
    const inlineCommentRef = project.task.comment(commentId);
    const childMilestoneRef = milestone(taskId);
    const unbrandedChildRef = unbrandedChild("setting-1");
    const customTokenRef = customToken(customTokenId);

    expectTypeOf(workspaceRef.id).toEqualTypeOf<WorkspaceId>();
    expectTypeOf(workspaceRef.$resource.id).toEqualTypeOf<WorkspaceId>();
    expectTypeOf(workspaceRef).toExtend<ResourceSubjectRef<"workspace", WorkspaceId>>();
    expectTypeOf(workspaceRef.owner.resource.id).toEqualTypeOf<WorkspaceId>();
    expectTypeOf(workspaceRef.manage.resource.id).toEqualTypeOf<WorkspaceId>();
    expectTypeOf(workspace.idSchema).toEqualTypeOf<z.ZodType<WorkspaceId>>();

    expectTypeOf(projectRef.id).toEqualTypeOf<ProjectId>();
    expectTypeOf(projectRef.$resource.id).toEqualTypeOf<ProjectId>();
    expectTypeOf(projectRef.maintainer).toExtend<DslRoleSlot<"project", "maintainer", ActorRef<"user">, ProjectId>>();
    expectTypeOf(projectRef.edit).toEqualTypeOf<DslPermissionTarget<"project", "edit", ProjectId>>();

    expectTypeOf(inlineTaskRef.id).toEqualTypeOf<TaskId>();
    expectTypeOf(inlineTaskRef.edit.resource.id).toEqualTypeOf<TaskId>();
    expectTypeOf(inlineTaskRef.project.resource.id).toEqualTypeOf<TaskId>();

    expectTypeOf(inlineCommentRef.id).toEqualTypeOf<CommentId>();
    expectTypeOf(inlineCommentRef.edit.resource.id).toEqualTypeOf<CommentId>();

    expectTypeOf(childMilestoneRef.id).toEqualTypeOf<TaskId>();
    expectTypeOf(childMilestoneRef.edit.resource.id).toEqualTypeOf<TaskId>();

    expectTypeOf(customTokenRef.id).toEqualTypeOf<CustomTokenId>();

    // Unbranded root, inline child, and .child() resources continue to accept plain strings.
    const noteRef = note("note-1");
    const auditLogRef = workspace.audit_log("audit-1");
    expectTypeOf(noteRef.id).toEqualTypeOf<string>();
    expectTypeOf(auditLogRef.id).toEqualTypeOf<string>();
    expectTypeOf(unbrandedChildRef.id).toEqualTypeOf<string>();

    // Runtime client works cleanly with branded IDs.
    const client = createAccessClient(new FakeAuthorization());
    const validClientCalls = async () => {
      await client.add(workspaceRef, projectRef.workspace);
      await client.add(workspaceRef, unbrandedChildRef.workspace);
      await client.add(user("u1"), projectRef.maintainer);
      await client.add(projectRef, inlineTaskRef.project);
      await client.add(projectRef, childMilestoneRef.project);
      await client.add(folder(parentFolderId), folder(childFolderId).parent);
      await client.add(workspaceRef, document("doc-1").parent);
      await client.add(folder(parentFolderId), document("doc-1").parent);
      await client.can(user("u1"), projectRef.edit);
      await client.can(user("u1"), inlineTaskRef.edit);
      await client.can(user("u1"), childMilestoneRef.edit);
      await client.listDirect(projectRef.maintainer);
    };

    const invalidBrandedCalls = async () => {
      // @ts-expect-error -- WorkspaceId cannot be passed to project(id)
      project(workspaceId);
      // @ts-expect-error -- raw string cannot be passed to project(id)
      project("raw-string");
      // @ts-expect-error -- ProjectId cannot be passed to workspace(id)
      workspace(projectId);
      // @ts-expect-error -- raw string cannot be passed to workspace(id)
      workspace("raw-string");
      // @ts-expect-error -- ProjectId cannot be passed to inline child project.task(id)
      project.task(projectId);
      // @ts-expect-error -- raw string cannot be passed to inline child project.task(id)
      project.task("raw-string");
      // @ts-expect-error -- TaskId cannot be passed to deeply nested inline child project.task.comment(id)
      project.task.comment(taskId);
      // @ts-expect-error -- ProjectId cannot be passed to .child() resource milestone(id)
      milestone(projectId);
      // @ts-expect-error -- raw string cannot be passed to .child() resource milestone(id)
      milestone("raw-string");
      // @ts-expect-error -- ProjectId cannot be passed to recursive folder(id)
      folder(projectId);
      // @ts-expect-error -- raw string cannot be passed to Zod-branded customToken(id)
      customToken("raw-string");
      // @ts-expect-error -- projectRef cannot be added to workspace parent slot
      await client.add(projectRef, projectRef.workspace);
      // @ts-expect-error -- projectRef cannot be added to document multi-parent slot
      await client.add(projectRef, document("doc-1").parent);
    };

    // Mixed branded + unbranded resources compile cleanly in compileAccess.
    const model = compileAccess([
      user,
      workspace,
      project,
      milestone,
      unbrandedChild,
      note,
      folder,
      document,
      customToken,
    ]);
    expect(model.definitions.length).toBeGreaterThanOrEqual(11);
    expect(typeof validClientCalls).toBe("function");
    expect(typeof invalidBrandedCalls).toBe("function");
    expect(projectRef.id).toBe(projectId);
    expect(inlineTaskRef.id).toBe(taskId);
    expect(childMilestoneRef.id).toBe(taskId);
    expect(noteRef.id).toBe("note-1");
  });
});
