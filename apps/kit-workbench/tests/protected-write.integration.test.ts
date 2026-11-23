import { randomUUID } from "node:crypto";

import { compileAccess } from "@dads-framework/access";
import { relationshipWrite } from "@dads-framework/access/runtime";
import { withSystemActor } from "@dads-framework/core/audit-actor";
import { createHttpApp, registerRoutes } from "@dads-framework/http";
import { sql } from "drizzle-orm";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { expect, it } from "vitest";

import { apiEntrypoints } from "../assembly/api-entrypoints.js";
import { migrate } from "../assembly/migrations.js";
import { openServices, provideServices } from "../assembly/services.js";
import { account, tenantAccess } from "../libraries/app-runtime/index.js";

it(
  "rechecks permission after the HTTP gate and rolls back data and access together",
  { timeout: 90_000 },
  async () => {
    const postgres = await new PostgreSqlContainer(
      "postgres:16-alpine",
    ).start();
    try {
      const databaseUrl = postgres.getConnectionUri();
      await migrate(databaseUrl);
      const baseUrl = "http://127.0.0.1:3800";
      const config = {
        databaseUrl,
        baseUrl,
        secret: "fixture-signing-key-with-forty-characters",
        enqueueEmail: () => Promise.resolve(),
        preparePermissionChecks: true,
      };
      const provider = provideServices((scope) =>
        openServices(scope, config, model, composed.flags),
      );
      const composed = apiEntrypoints.customer(provider);
      const model = compileAccess(composed.access, {
        allowLookupResourcesOn: [tenantAccess.tenant],
      });
      const runtime = await composed.start();
      try {
        const { authorization, db, tenants, writeWithPermission } =
          runtime.read(provider);
        const notesPermission = tenantAccess.tenant.permissions.view;
        const owner = { type: account.wireName, id: randomUUID() };
        const subject = { type: account.wireName, id: randomUUID() };
        const tenant = await withSystemActor("test", () =>
          tenants.create(owner.id, "Test"),
        );
        const resource = {
          type: notesPermission.entityWireName,
          id: tenant.id,
        };
        const memberRole = tenantAccess.tenant.roles.member.roleName;
        const membership = relationshipWrite(resource, memberRole, subject);
        const check = {
          subject,
          resource,
          permission: notesPermission.permissionName,
        };
        const removeMembership = {
          resourceType: resource.type,
          resourceId: resource.id,
          relation: memberRole,
        };
        await authorization.writeRelationships([membership]);

        const app = await createHttpApp({
          nodeEnv: "test",
          trustedOrigins: [baseUrl],
          logger: false,
        });
        try {
          registerRoutes(app, {
            routes: runtime.routes,
            accessModel: model,
            subjects: { resolve: () => Promise.resolve(subject) },
            authorization: {
              async check(query) {
                const allowed = await authorization.check(query);
                // Commit a revoke from outside the write while the HTTP gate's result is in flight.
                await authorization.deleteRelationships(removeMembership);
                return allowed;
              },
            },
          });
          expect(await authorization.check(check)).toBe(true);
          const refused = await app.inject({
            method: "POST",
            url: `/tenants/${tenant.id}/notes`,
            headers: { origin: baseUrl },
            payload: { text: "Do not write" },
          });
          expect(refused.statusCode).toBe(404);
          expect(await authorization.check(check)).toBe(false);
          expect(
            (await db.execute(sql`SELECT id FROM starter_note`)).rows,
          ).toEqual([]);
        } finally {
          await app.close();
        }

        await authorization.writeRelationships([membership]);
        const forcedRollback = new Error("rollback both writes");
        await expect(
          withSystemActor("test", () =>
            writeWithPermission(
              { subject, resourceId: tenant.id, permission: notesPermission },
              async (tx, scopedAuthorization) => {
                await tx.execute(
                  sql`INSERT INTO starter_note (id, tenant_id, text) VALUES (${randomUUID()}, ${tenant.id}, 'Discard')`,
                );
                await scopedAuthorization.deleteRelationships(removeMembership);
                throw forcedRollback;
              },
            ),
          ),
        ).rejects.toBe(forcedRollback);
        expect(
          (await db.execute(sql`SELECT id FROM starter_note`)).rows,
        ).toEqual([]);
        expect(await authorization.check(check)).toBe(true);

        const noteId = randomUUID();
        await withSystemActor("test", () =>
          db.execute(
            sql`INSERT INTO starter_note (id, tenant_id, text) VALUES (${noteId}, ${tenant.id}, 'Before')`,
          ),
        );
        let attempts = 0;
        await expect(
          withSystemActor("test", () =>
            writeWithPermission(
              { subject, resourceId: tenant.id, permission: notesPermission },
              async (tx) => {
                attempts += 1;
                await db.execute(
                  sql`UPDATE starter_note SET text = 'Other commit' WHERE id = ${noteId}`,
                );
                await tx.execute(
                  sql`UPDATE starter_note SET text = 'Stale write' WHERE id = ${noteId}`,
                );
              },
            ),
          ),
        ).rejects.toMatchObject({
          kind: "conflict",
          code: "POSTGRES_CONFLICT",
          details: { retryable: true },
        });
        expect(attempts).toBe(1);
        expect(
          (
            await db.execute(
              sql`SELECT text FROM starter_note WHERE id = ${noteId}`,
            )
          ).rows,
        ).toEqual([{ text: "Other commit" }]);
      } finally {
        await runtime.stop();
      }
    } finally {
      await postgres.stop();
    }
  },
);
