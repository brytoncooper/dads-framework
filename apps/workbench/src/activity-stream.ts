import { fromParam, sseRoute } from "@dads-framework/http";

import { workbenchWorkspace } from "./access.js";
import { workspaceParams } from "./contracts.js";
import type { WorkbenchOperations } from "./operations/workbench-operations.js";
import { routeOutcome } from "./route-outcome.js";

/** Streams the current activity page after the same workspace permission as the feed. */
export function workbenchActivityStream(operations: WorkbenchOperations) {
  const permission = workbenchWorkspace.permissions.view;
  return sseRoute({
    path: "/api/workspaces/:workspaceId/activity/stream",
    summary: "Stream recent workspace activity",
    access: {
      kind: "permission",
      resourceType: permission.entityWireName,
      permission: permission.permissionName,
      resourceId: fromParam("workspaceId"),
    },
    openapi: {
      parameters: [
        {
          in: "path",
          name: "workspaceId",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Recent activity as server-sent events",
          content: { "text/event-stream": { schema: { type: "string" } } },
        },
        "404": { description: "Workspace unavailable" },
        "503": { description: "Authorization unavailable" },
      },
    },
    async handler({ subject, request, reply, open }) {
      const params = workspaceParams.safeParse(request.params);
      if (!params.success || subject === null) {
        await reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Workspace unavailable" },
        });
        return;
      }
      const page = await routeOutcome(() =>
        operations.listActivity(subject, params.data.workspaceId, undefined, {
          page: 1,
          perPage: 100,
        }),
      );
      open((stream) => {
        for (const activity of page.data) stream.send(activity);
        return () => undefined;
      });
    },
  });
}
