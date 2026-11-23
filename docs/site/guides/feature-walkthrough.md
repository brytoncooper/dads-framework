# Build a Feature End to End

Walk through one concrete child feature — **`workspace → project`** — from permission rules and Postgres storage to pure rules, HTTP routes, typed client calls, and dual-backend tests.

## Step 1 — Declare the policy (`domains/projects/access.ts`)

Declare the actor, parent resource, and child resource once in plain TypeScript. Every child states `inherit` explicitly (`"all"`, `"none"`, or a list of parent permissions) so unmentioned permissions stay fail-closed:

```ts
import { actor, anyOf, compileAccess, resource } from "@dads-framework/access";

export const user = actor("user");

export const workspace = resource("workspace", {
  roles: { member: user, admin: user },
  can: ({ member, admin }) => ({ view: anyOf(member, admin), manage: admin }),
  children: {
    project: {
      inherit: ["view"],
      roles: { editor: user },
      can: ({ editor }) => ({ edit: editor }),
    },
  },
});

export const accessModel = compileAccess([workspace]);
```

> **Important:** Declaring `children: { project }` defines the authorization rule — it does **not** create rows or link any project to a workspace in Postgres. Your app supplies the actual parent link in Step 2.
>
> **Tip (Branded IDs & Catalog):** Pass `id: workspaceIdSchema` / `id: projectIdSchema` (from `entityIdSchema(...)` in `@dads-framework/core/contract`) on `resource(...)` and child specs so passing a `WorkspaceId` where a `ProjectId` is expected fails at compile time. Add `grantable(...)` metadata and call `buildGrantableCatalog(accessModel)` from `@dads-framework/access/catalog` to drive Roles & Permissions UIs directly from this policy.

## Step 2 — Supply the parent relationship in Postgres

Pick the option that matches your schema — never maintain both for the same role.

### Option A: Bind an existing FK column with `columnRelations` (recommended)

When `projects.workspace_id` already exists, bind `workspace.project.roles.workspace` on `PostgresAuthorization` in `assembly/authorization.ts` — zero dual-writes, zero separate parent tuple (run `columnRelationIndexSql(columnRelations)` in your migration for the `(workspace_id, id)` index):

```ts
import { PostgresAuthorization, preparePostgresChecks } from "@dads-framework/postgres-access";
import type { Pool } from "pg";
import { accessModel, workspace } from "../domains/projects/access.js";

export function createAuthorization(pool: Pool): PostgresAuthorization {
  return new PostgresAuthorization({
    model: accessModel,
    namespace: "app",
    executor: preparePostgresChecks(pool),
    columnRelations: [
      { role: workspace.project.roles.workspace, table: "projects", idColumn: "id", targetIdColumn: "workspace_id" },
    ],
  });
}
```

### Option B: Write the parent tuple inside the same transaction

When the relationship lives in tuples (or has no FK column), write the parent link in the same transaction that inserts the project:

```ts
import { createAccessClient } from "@dads-framework/access/runtime";
import { withProtectedPgTransaction } from "@dads-framework/postgres-access";
import { workspace } from "../access.js";

await withProtectedPgTransaction(
  { pool, authorization, retries: 2 },
  async ({ client, authorization: scopedAuthorization }) => {
    await client.query("INSERT INTO projects (id, title) VALUES ($1, $2)", [projectId, title]);
    await createAccessClient(scopedAuthorization).add(workspace(wsId), workspace.project(projectId).workspace);
  },
);
```

## Step 3 — Define pure rules & per-operation contracts

Keep deterministic domain rules in `domains/projects/pure/project-rules.ts` (zero I/O) and standalone `*Operation` contracts in `domains/projects/contract/wire.ts`:

```ts
// domains/projects/pure/project-rules.ts
export function normalizeProjectTitle(rawTitle: string): string {
  return rawTitle.trim().replace(/\s+/g, " ");
}
```

```ts
// domains/projects/contract/wire.ts
import { listOperation, paginationQuerySchema, patchOperation } from "@dads-framework/core/contract";
import { z } from "zod";

export const projectSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  title: z.string().min(1),
});
export const listProjectsOp = listOperation({ path: "/projects", query: paginationQuerySchema, item: projectSchema });
export const renameProjectOp = patchOperation({
  path: "/projects/:projectId",
  params: z.object({ projectId: z.string().min(1) }),
  body: z.strictObject({ title: z.string().trim().min(1).max(120) }),
  response: projectSchema,
});
```

## Step 4 — Wire the list query & protected mutation (`domains/projects/server/routes.ts`)

Lists resolve permissions and read rows in one snapshot (`withReadSnapshot` + `resolveFilter` with `scopeColumns: "auto"`). Mutations enforce `requires(...)` at the HTTP edge and re-check `can(...)` inside `withProtectedPgTransaction`, returning `404` on denial so unauthorized callers never learn whether an ID exists:

```ts
import { notFoundError } from "@dads-framework/core/errors";
import { fromParam, listRoute, patchRoute, requires, requireSession, routeGroup } from "@dads-framework/http";
import {
  withProtectedPgTransaction,
  withReadSnapshot,
  type PostgresAuthorization,
} from "@dads-framework/postgres-access";
import type { Pool } from "pg";
import { user, workspace } from "../access.js";
import { listProjectsOp, projectSchema, renameProjectOp } from "../contract/wire.js";
import { normalizeProjectTitle } from "../pure/project-rules.js";

export function projectRoutes(deps: { readonly pool: Pool; readonly authorization: PostgresAuthorization }) {
  return routeGroup("Projects", [
    listRoute({
      operation: listProjectsOp,
      summary: "List visible projects",
      access: requireSession,
      handler: ({ query, subject }) =>
        withReadSnapshot(deps, async ({ client, authorization: scopedAuthorization }) => {
          const filter = await scopedAuthorization.resolveFilter({
            subject: user(subject.id),
            permission: workspace.project.permissions.view,
            idColumn: "p.id",
            scopeColumns: "auto",
            paramOffset: 3,
          });
          const { rows } = await client.query(
            `SELECT p.id, p.workspace_id AS "workspaceId", p.title, COUNT(*) OVER()::int AS total
               FROM projects p WHERE ${filter.sql} ORDER BY p.id ASC LIMIT $1 OFFSET $2`,
            [query.perPage, (query.page - 1) * query.perPage, ...filter.values],
          );
          return { items: rows.map((row) => projectSchema.parse(row)), total: Number(rows[0]?.total ?? 0) };
        }),
    }),
    patchRoute({
      operation: renameProjectOp,
      summary: "Rename a project",
      access: requires(workspace.project.permissions.edit, fromParam("projectId")),
      handler: ({ params, body, subject }) =>
        withProtectedPgTransaction({ ...deps, retries: 2 }, async ({ client, authorization: scopedAuthorization }) => {
          const allowed = await scopedAuthorization.can(
            user(subject.id),
            workspace.project.permissions.edit,
            params.projectId,
          );
          if (!allowed) throw notFoundError("Project not found.");
          const { rows } = await client.query(
            `UPDATE projects SET title = $1 WHERE id = $2 RETURNING id, workspace_id AS "workspaceId", title`,
            [normalizeProjectTitle(body.title), params.projectId],
          );
          if (rows[0] === undefined) throw notFoundError("Project not found.");
          return projectSchema.parse(rows[0]);
        }),
    }),
  ]);
}
```

## Step 5 — Call it from the client (`apps/web/features/projects/client.ts`)

Build a typed client directly from `contract/wire.ts` (or invoke a single contract with `callApi`):

```ts
import { createApiClient } from "@dads-framework/client";
import { listProjectsOp, renameProjectOp } from "../../../../domains/projects/contract/wire.js";

export const projectsClient = createApiClient({ list: listProjectsOp, rename: renameProjectOp });
const page = await projectsClient.list({ query: { page: 1, perPage: 20 } });
const updated = await projectsClient.rename({ params: { projectId: "proj-1" }, body: { title: "Roadmap" } });
```

## Step 6 — Test the exact same scenario in memory and against Postgres (`domains/projects/access.test.ts`)

Write your access proof once and run it synchronously in memory (`createAccessHarness`), asynchronously in memory (`proveAccess`), and unchanged against `PostgresAuthorization` or `SqliteAuthorization`:

```ts
import { createAccessHarness, proveAccess, type AccessScenarioVerbs } from "@dads-framework/access/testing";
import { describe, it } from "vitest";
import { accessModel, user, workspace } from "./access.js";

function projectPolicyScenario(scenario: AccessScenarioVerbs) {
  const member = scenario.actor(user, "alice");
  const editor = scenario.actor(user, "bob");
  const outsider = scenario.actor(user, "outsider");

  scenario.grant(workspace.roles.member, "ws-1").to(member);
  scenario.grant(workspace.project.roles.workspace, "proj-1").to(workspace("ws-1"));
  scenario.grant(workspace.project.roles.editor, "proj-1").to(editor);

  scenario.assertMatrix(workspace.project, "proj-1", {
    permissions: [workspace.project.permissions.view, workspace.project.permissions.edit],
    cases: [
      [member, ["allow", "deny"]],
      [editor, ["deny", "allow"]],
      [outsider, ["deny", "deny"]],
    ],
  });

  scenario.revoke(workspace.roles.member, "ws-1").from(member);
  scenario.assertCannot(member, workspace.project.permissions.view, "proj-1");
}

describe("workspace -> project access", () => {
  it("proves inheritance, editor grants, and revocation in memory and SQL", async () => {
    projectPolicyScenario(createAccessHarness(accessModel)); // synchronous in memory (<1 ms)
    await proveAccess(accessModel, {}, projectPolicyScenario); // async in memory
    // Reuse unchanged against PostgresAuthorization or SqliteAuthorization:
    // await proveAccess(accessModel, { authorization: postgresAuthorization }, projectPolicyScenario);
  });
});
```

> **Tip for Option A (`columnRelations`) in Postgres integration tests:** insert the `projects (id, workspace_id)` row in SQL for the column-backed parent link, and let `proveAccess` manage tuple-backed roles (`workspace.member`, `project.editor`) and assertions.

## Next steps

- [Access & Permissions](permissions.md) · [Where Does Code Go?](where-code-goes.md) · [Routes, Contracts & Clients](routes-and-contracts.md)
