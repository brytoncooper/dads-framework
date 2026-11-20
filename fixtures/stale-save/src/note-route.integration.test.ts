import { FakeAuthorization } from "@dads-framework/authorization/testing";
import { apiErrorSchema, ROW_VERSION_CONFLICT } from "@dads-framework/contract";
import { createHttpApp, registerRoutes } from "@dads-framework/http";
import {
  startTestPostgres,
  type TestPostgres,
} from "@dads-framework/postgres/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, expect, it } from "vitest";

import { editor, noteAccess, noteRoutes, notes } from "./note-route.js";

const noteId = "note-1";
const editorSubject = { type: editor.wireName, id: "editor-1" };
const outsiderSubject = { type: editor.wireName, id: "editor-2" };
const editorRole = noteAccess.roles.editor;
const editNote = noteAccess.permissions.edit;

let database: TestPostgres | undefined;
let app: Awaited<ReturnType<typeof createHttpApp>> | undefined;

beforeAll(async () => {
  database = await startTestPostgres();
  await database.pool.query(`
    CREATE TABLE stale_save_notes (
      id text PRIMARY KEY,
      title text NOT NULL,
      row_version integer NOT NULL DEFAULT 1
    )
  `);
  const db = drizzle(database.pool);
  await db.insert(notes).values({ id: noteId, title: "Original" });
  const authorization = new FakeAuthorization({
    [editNote.entityWireName]: {
      [editNote.permissionName]: [editorRole.roleName],
    },
  });
  authorization.seed({
    resource: { type: editNote.entityWireName, id: noteId },
    relation: editorRole.roleName,
    subject: editorSubject,
  });
  app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  registerRoutes(app, {
    routes: noteRoutes(db),
    authorization,
    subjects: {
      resolve: (request) =>
        Promise.resolve(
          request.headers["x-fixture-editor"] === "1"
            ? editorSubject
            : outsiderSubject,
        ),
    },
  });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await database?.stop();
});

function fixtureApp() {
  if (app === undefined) throw new Error("Fixture app failed to start.");
  return app;
}

function edit(title: string, expectedRowVersion: number, asEditor = true) {
  return fixtureApp().inject({
    method: "PATCH",
    url: `/notes/${noteId}`,
    headers: { "x-fixture-editor": asEditor ? "1" : "0" },
    payload: { title, expectedRowVersion },
  });
}

it("rejects missing version and denies an editor without a relationship", async () => {
  const missingVersion = await fixtureApp().inject({
    method: "PATCH",
    url: `/notes/${noteId}`,
    headers: { "x-fixture-editor": "1" },
    payload: { title: "No revision" },
  });
  expect(missingVersion.statusCode).toBe(400);

  const denied = await edit("Unauthorized", 1, false);
  expect(denied.statusCode).toBe(404);
  expect(apiErrorSchema.parse(denied.json()).error.code).not.toBe(
    ROW_VERSION_CONFLICT,
  );
  const staleDenied = await edit("Unauthorized", 0, false);
  expect(staleDenied.statusCode).toBe(404);
});

it("accepts one of two concurrent drafts and leaves the winner intact", async () => {
  const results = await Promise.all([
    edit("First draft", 1),
    edit("Second draft", 1),
  ]);
  expect(results.map(({ statusCode }) => statusCode).sort()).toEqual([
    200, 409,
  ]);
  const winner = results.find(({ statusCode }) => statusCode === 200);
  const refusal = results.find(({ statusCode }) => statusCode === 409);
  expect(apiErrorSchema.parse(refusal?.json()).error.code).toBe(
    ROW_VERSION_CONFLICT,
  );

  const stored = await database?.pool.query(
    "SELECT title, row_version FROM stale_save_notes",
  );
  expect(stored?.rows).toEqual([
    {
      title: results[0].statusCode === 200 ? "First draft" : "Second draft",
      row_version: 2,
    },
  ]);
  expect(winner?.json()).toMatchObject({ data: { rowVersion: 2 } });
});
