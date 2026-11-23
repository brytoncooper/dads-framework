// Generated from routes.ts. Run npm run workbench:generate; do not edit.
import { z } from "zod";
import { workbenchFetch, type WorkbenchClientOptions, type WorkbenchRequest } from "./client-transport.js";
import * as contract from "./contracts.js";
export function createClient(options: WorkbenchClientOptions) {
  const request = workbenchFetch(options);
  return {
    listWorkspaces: async (input: { readonly query: NonNullable<WorkbenchRequest["query"]> }) => {
      return z.array(contract.workspaceResponse).parse(await request("GET", "/api/workspaces", input));
    },
    createWorkspace: async (input: { readonly body: z.input<typeof contract.createWorkspaceBody> }) => {
      return contract.workspaceResponse.parse(await request("POST", "/api/workspaces", input));
    },
    getWorkspace: async (input: { readonly params: { readonly workspaceId: string } }) => {
      return contract.workspaceResponse.parse(await request("GET", "/api/workspaces/:workspaceId", input));
    },
    updateWorkspace: async (input: {
      readonly params: { readonly workspaceId: string };
      readonly body: z.input<typeof contract.updateWorkspaceBody>;
    }) => {
      return contract.workspaceResponse.parse(await request("PATCH", "/api/workspaces/:workspaceId", input));
    },
    deleteWorkspace: async (input: { readonly params: { readonly workspaceId: string } }) => {
      await request("DELETE", "/api/workspaces/:workspaceId", input);
    },
    listTasks: async (input: {
      readonly params: { readonly workspaceId: string };
      readonly query: NonNullable<WorkbenchRequest["query"]>;
    }) => {
      return z.array(contract.taskResponse).parse(await request("GET", "/api/workspaces/:workspaceId/tasks", input));
    },
    createTask: async (input: {
      readonly params: { readonly workspaceId: string };
      readonly body: z.input<typeof contract.createTaskBody>;
    }) => {
      return contract.taskResponse.parse(await request("POST", "/api/workspaces/:workspaceId/tasks", input));
    },
    getTask: async (input: { readonly params: { readonly taskId: string } }) => {
      return contract.taskResponse.parse(await request("GET", "/api/tasks/:taskId", input));
    },
    updateTask: async (input: {
      readonly params: { readonly taskId: string };
      readonly body: z.input<typeof contract.updateTaskBody>;
    }) => {
      return contract.taskResponse.parse(await request("PATCH", "/api/tasks/:taskId", input));
    },
    deleteTask: async (input: { readonly params: { readonly taskId: string } }) => {
      await request("DELETE", "/api/tasks/:taskId", input);
    },
    claimTask: async (input: {
      readonly params: { readonly taskId: string };
      readonly body: z.input<typeof contract.claimTaskBody>;
    }) => {
      return contract.taskResponse.parse(await request("POST", "/api/tasks/:taskId/claim", input));
    },
    listMembers: async (input: {
      readonly params: { readonly workspaceId: string };
      readonly query: NonNullable<WorkbenchRequest["query"]>;
    }) => {
      return z
        .array(contract.memberResponse)
        .parse(await request("GET", "/api/workspaces/:workspaceId/members", input));
    },
    grantMember: async (input: {
      readonly params: { readonly workspaceId: string };
      readonly body: z.input<typeof contract.grantMemberBody>;
    }) => {
      return contract.memberResponse.parse(await request("POST", "/api/workspaces/:workspaceId/members", input));
    },
    revokeMember: async (input: { readonly params: { readonly workspaceId: string; readonly userId: string } }) => {
      await request("DELETE", "/api/workspaces/:workspaceId/members/:userId", input);
    },
    listArtifacts: async (input: {
      readonly params: { readonly taskId: string };
      readonly query: NonNullable<WorkbenchRequest["query"]>;
    }) => {
      return z.array(contract.artifactResponse).parse(await request("GET", "/api/tasks/:taskId/artifacts", input));
    },
    createArtifact: async (input: {
      readonly params: { readonly taskId: string };
      readonly body: z.input<typeof contract.createArtifactBody>;
    }) => {
      return contract.artifactResponse.parse(await request("POST", "/api/tasks/:taskId/artifacts", input));
    },
    listActivity: async (input: {
      readonly params: { readonly workspaceId: string };
      readonly query: NonNullable<WorkbenchRequest["query"]>;
    }) => {
      return z
        .array(contract.activityResponse)
        .parse(await request("GET", "/api/workspaces/:workspaceId/activity", input));
    },
  };
}
