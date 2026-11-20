// The runner's contract: a pre-journal store converges once
// through the desired-state path, every entry after applies strictly
// (before -> schema -> after -> marker), a failure leaves the marker
// unwritten so re-runs resume, destructive entries snapshot the datastore
// first, and a store ahead of or diverged from the journal is refused.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeSchemaStore } from "../testing/fake-schema-store.js";
import type { AuthorizationMigration } from "./journal/journal-entry.js";
import {
  pendingAuthorizationMigrationIds,
  readAppliedAuthorizationMigrationIds,
  runAuthorizationMigrations,
} from "./run-authorization-migrations.js";

const JOURNAL_SCHEMA_LINES =
  "definition authz/migration_journal { relation applied: authz/migration_version }\n" +
  "definition authz/migration_version {}\n";

const silentLog = { info: () => undefined };

function writeJournalFolder(
  entries: readonly { id: string; body?: string }[],
): string {
  const folder = mkdtempSync(join(tmpdir(), "authz-run-"));
  for (const entry of entries) {
    mkdirSync(join(folder, entry.id));
    writeFileSync(
      join(folder, entry.id, "schema.zed"),
      `// ${entry.id}\n${JOURNAL_SCHEMA_LINES}${entry.body ?? ""}`,
    );
  }
  return folder;
}

/** A journaled store: live schema carries the journal definition. */
function journaledStore(applied: readonly string[]): FakeSchemaStore {
  const store = new FakeSchemaStore({
    initialSchema: `// live\n${JOURNAL_SCHEMA_LINES}`,
  });
  store.appliedMarkers.push(...applied);
  return store;
}

describe("runAuthorizationMigrations", () => {
  it("genesis on an empty store: converges the first entry, applies the rest strictly", async () => {
    const journalFolder = writeJournalFolder([
      { id: "0001_baseline" },
      { id: "0002_next" },
    ]);
    const steps: string[] = [];
    const journal: readonly AuthorizationMigration[] = [
      { id: "0001_baseline" },
      {
        id: "0002_next",
        beforeSchemaWrite: () => {
          steps.push("before:0002_next");
          return Promise.resolve();
        },
      },
    ];
    const store = new FakeSchemaStore();

    await runAuthorizationMigrations({
      journal,
      journalFolder,
      store,
      log: silentLog,
    });

    expect(store.appliedMarkers).toEqual(["0001_baseline", "0002_next"]);
    expect(steps).toEqual(["before:0002_next"]);
    const schemaWrites = store.operations.filter((operation) =>
      operation.startsWith("writeSchema:"),
    );
    expect(schemaWrites).toEqual([
      "writeSchema:0001_baseline",
      "writeSchema:0002_next",
    ]);
  });

  it("genesis on a pre-journal store deletes tuples left under removed shapes, then journals", async () => {
    const journalFolder = writeJournalFolder([{ id: "0001_baseline" }]);
    const store = new FakeSchemaStore({
      // Pre-journal live schema with a relation the baseline no longer has —
      // the AWS-prototype cutover case.
      initialSchema:
        "definition user {}\ndefinition test/thing { relation gone: user }\n",
    });

    await runAuthorizationMigrations({
      journal: [{ id: "0001_baseline" }],
      journalFolder,
      store,
      log: silentLog,
    });

    expect(store.operations).toContain("delete:test/thing");
    expect(store.appliedMarkers).toEqual(["0001_baseline"]);
  });

  it("skips already-applied entries and applies only the pending tail", async () => {
    const journalFolder = writeJournalFolder([
      { id: "0001_baseline" },
      { id: "0002_next" },
    ]);
    const store = journaledStore(["0001_baseline"]);

    await runAuthorizationMigrations({
      journal: [{ id: "0001_baseline" }, { id: "0002_next" }],
      journalFolder,
      store,
      log: silentLog,
    });

    const schemaWrites = store.operations.filter((operation) =>
      operation.startsWith("writeSchema:"),
    );
    expect(schemaWrites).toEqual(["writeSchema:0002_next"]);
  });

  it("is a no-op when everything is applied", async () => {
    const journalFolder = writeJournalFolder([{ id: "0001_baseline" }]);
    const store = journaledStore(["0001_baseline"]);

    await runAuthorizationMigrations({
      journal: [{ id: "0001_baseline" }],
      journalFolder,
      store,
      log: silentLog,
    });

    expect(store.operations).toEqual([]);
  });

  it("snapshots the datastore before a destructive entry", async () => {
    const journalFolder = writeJournalFolder([
      {
        id: "0001_baseline",
        body: "definition test/doc { relation owner: user }\ndefinition user {}\n",
      },
      { id: "0002_drop_doc", body: "definition user {}\n" },
    ]);
    const store = journaledStore(["0001_baseline"]);
    const snapshots: string[] = [];

    await runAuthorizationMigrations({
      journal: [
        { id: "0001_baseline" },
        {
          id: "0002_drop_doc",
          beforeSchemaWrite: async (client) => {
            await client.deleteRelationships({ resourceType: "test/doc" });
          },
        },
      ],
      journalFolder,
      store,
      log: silentLog,
      snapshotDatastore: () => {
        snapshots.push("cloned");
        return Promise.resolve("cloned");
      },
    });

    expect(snapshots).toEqual(["cloned"]);
    expect(store.appliedMarkers).toEqual(["0001_baseline", "0002_drop_doc"]);
  });

  it("names the missing relationship step when SpiceDB refuses a destructive write, and resumes on re-run", async () => {
    const journalFolder = writeJournalFolder([
      { id: "0001_baseline" },
      { id: "0002_next" },
    ]);
    const store = journaledStore(["0001_baseline"]);
    store.failOnNextSchemaWrite(
      "unable to update schema: cannot delete relation `editor` in object definition `test/document`, as a relationship exists with it",
    );
    const journal: readonly AuthorizationMigration[] = [
      { id: "0001_baseline" },
      { id: "0002_next" },
    ];

    await expect(
      runAuthorizationMigrations({
        journal,
        journalFolder,
        store,
        log: silentLog,
      }),
    ).rejects.toThrow(
      /0002_next is destructive for test\/document#editor but its relationship step did not clear/,
    );
    expect(store.appliedMarkers).toEqual(["0001_baseline"]);

    await runAuthorizationMigrations({
      journal,
      journalFolder,
      store,
      log: silentLog,
    });
    expect(store.appliedMarkers).toEqual(["0001_baseline", "0002_next"]);
  });

  it("names the entry and phase when a relationship step fails", async () => {
    const journalFolder = writeJournalFolder([
      { id: "0001_baseline" },
      { id: "0002_next" },
    ]);
    const store = journaledStore(["0001_baseline"]);

    await expect(
      runAuthorizationMigrations({
        journal: [
          { id: "0001_baseline" },
          {
            id: "0002_next",
            beforeSchemaWrite: () =>
              Promise.reject(new Error("TODO: write the tuple step")),
          },
        ],
        journalFolder,
        store,
        log: silentLog,
      }),
    ).rejects.toThrow(
      /authorization migration 0002_next failed during beforeSchemaWrite: TODO/,
    );
    expect(store.appliedMarkers).toEqual(["0001_baseline"]);
  });

  it("refuses a store that is ahead of the journal", async () => {
    const journalFolder = writeJournalFolder([{ id: "0001_baseline" }]);
    const store = journaledStore(["0001_baseline", "0002_from_the_future"]);

    await expect(
      runAuthorizationMigrations({
        journal: [{ id: "0001_baseline" }],
        journalFolder,
        store,
        log: silentLog,
      }),
    ).rejects.toThrow(/ahead of this build/);
  });

  it("refuses applied entries that are not a journal prefix", async () => {
    const journalFolder = writeJournalFolder([
      { id: "0001_baseline" },
      { id: "0002_next" },
    ]);
    const store = journaledStore(["0002_next"]);

    await expect(
      runAuthorizationMigrations({
        journal: [{ id: "0001_baseline" }, { id: "0002_next" }],
        journalFolder,
        store,
        log: silentLog,
      }),
    ).rejects.toThrow(/not a prefix of the journal/);
  });
});

describe("pendingAuthorizationMigrationIds", () => {
  it("reports everything pending for a pre-journal store, and nothing when caught up", async () => {
    const journalFolder = writeJournalFolder([{ id: "0001_baseline" }]);
    await expect(
      pendingAuthorizationMigrationIds({
        journal: [{ id: "0001_baseline" }],
        journalFolder,
        store: new FakeSchemaStore(),
      }),
    ).resolves.toEqual(["0001_baseline"]);

    await expect(
      pendingAuthorizationMigrationIds({
        journal: [{ id: "0001_baseline" }],
        journalFolder,
        store: journaledStore(["0001_baseline"]),
      }),
    ).resolves.toEqual([]);
  });
});

// The staff Migrations page reads the same markers the runner trusts, and the
// same pre-journal rule: markers on a store whose schema never carried the
// journal definition are not applied entries.
describe("readAppliedAuthorizationMigrationIds", () => {
  it("returns the applied markers of a journaled store, sorted", async () => {
    await expect(
      readAppliedAuthorizationMigrationIds(
        journaledStore(["0002_split_roles", "0001_baseline"]),
      ),
    ).resolves.toEqual(["0001_baseline", "0002_split_roles"]);
  });

  it("reports nothing applied for a pre-journal store, whatever tuples it holds", async () => {
    const store = new FakeSchemaStore();
    store.appliedMarkers.push("0001_baseline");

    await expect(readAppliedAuthorizationMigrationIds(store)).resolves.toEqual(
      [],
    );
  });
});
