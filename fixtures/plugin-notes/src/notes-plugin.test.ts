/**
 * What: the notes plugin, composed the way an app composes it, reaches every
 * kit it contributes to: its route answers through the HTTP kit, its job runs
 * in the in-process queue, the migration runner finds its migration, and its
 * access definition is the one the access kit emits.
 * Why: this is the end-to-end proof of the plugin contract.
 */
import { join } from "node:path";

import { compileAccess, emitAccessIr } from "@dads-framework/access";
import { FakeAuthorization } from "@dads-framework/authorization/testing";
import {
  buildTestApp,
  TEST_SUBJECT_HEADER,
} from "@dads-framework/http/testing";
import { createJobQueue } from "@dads-framework/job-queue";
import { discoverDomainMigrations } from "@dads-framework/migrations";
import { composeApp, providePlugin } from "@dads-framework/plugin";
import { startForTest } from "@dads-framework/plugin/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clockService, type NotesClock } from "./clock-service.js";
import { noteEntity } from "./notes-access.js";
import { notesPlugin } from "./notes-plugin.js";

const WORKSPACE_ROOT = join(import.meta.dirname, "..", "..", "..");
const fixedClock: NotesClock = { now: () => new Date("2026-11-19T12:00:00Z") };
const hostClock = providePlugin("host-clock", clockService, () => fixedClock);

function composeNotesApp() {
  return composeApp([notesPlugin, hostClock]);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the notes plugin, composed", () => {
  it("sets up after the host clock it requires", () => {
    expect(composeNotesApp().plugins).toEqual(["host-clock", "notes"]);
  });

  it("serves its route to the note's author and answers everyone else as if it did not exist", async () => {
    const harness = await startForTest(composeNotesApp());
    harness.running.read(notesPlugin).write("n1", "buy milk");
    const authorization = new FakeAuthorization({
      [noteEntity.wireName]: { view: ["author"] },
    });
    authorization.seed({
      resource: { type: noteEntity.wireName, id: "n1" },
      relation: "author",
      subject: { type: "user", id: "u1" },
    });
    const http = await buildTestApp({
      routes: harness.running.routes,
      authorization,
    });

    const allowed = await http.inject({
      method: "GET",
      url: "/notes/n1",
      headers: { [TEST_SUBJECT_HEADER]: "u1" },
    });
    const denied = await http.inject({
      method: "GET",
      url: "/notes/n1",
      headers: { [TEST_SUBJECT_HEADER]: "u2" },
    });

    expect(allowed.statusCode).toBe(200);
    // A refused read answers 404: the HTTP kit does not confirm the note exists.
    expect(denied.statusCode).toBe(404);
    await http.close();
    await harness.stopCleanly();
  });

  it("registers its job with the job queue, which runs it", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const movingClock = providePlugin("host-clock", clockService, () => ({
      now: () => now,
    }));
    const harness = await startForTest(composeApp([notesPlugin, movingClock]));
    const api = harness.running.read(notesPlugin);
    api.write("old", "from the start of the year");
    now = new Date("2026-11-19T00:00:00Z");
    const queue = createJobQueue(
      { queueName: "notes-plugin-test", driver: "in-process" },
      { info: () => undefined, error: () => undefined },
    );
    queue.register(harness.running.jobs);

    await queue.start();
    await queue.enqueue("notes.prune", { keepDays: 30 });
    await vi.waitFor(() => {
      expect(api.countNotes()).toBe(0);
    });

    await queue.close();
    await harness.stopCleanly();
  });

  it("gives the migration runner a folder whose migration it finds, owned by the plugin", async () => {
    const sources = composeNotesApp().migrationSources(WORKSPACE_ROOT);

    const migrations = await discoverDomainMigrations({
      workspace: { root: WORKSPACE_ROOT, sources, moduleAliases: {} },
    });

    expect(
      migrations.map((migration) => [migration.owner, migration.journalName]),
    ).toEqual([["notes", "20261119000000_notes_create_notes.migration"]]);
  });

  it("contributes its access definition, which the access kit emits", () => {
    const model = compileAccess(composeNotesApp().access);
    const emitted = emitAccessIr(model);

    expect(emitted.map((definition) => definition.wireName)).toEqual([
      "notes_user",
      "notes/note",
    ]);
    expect(emitted[1]?.permissions).toEqual([
      { name: "view", terms: [{ kind: "role", name: "author" }] },
    ]);
    expect(composeNotesApp().untrackedAuditTables).toEqual([
      "notes_read_marks",
    ]);
  });

  it("disposes its prune timer when the app stops", async () => {
    vi.useFakeTimers();
    const harness = await startForTest(composeNotesApp(), {
      leakProbe: () => vi.getTimerCount(),
    });

    expect(vi.getTimerCount()).toBe(1);
    await harness.stopCleanly();
    expect(vi.getTimerCount()).toBe(0);
  });
});
