import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { RelationshipWrite } from "@dads-framework/access/runtime";

import { FakeSchemaStore } from "../testing/fake-schema-store.js";
import { readAuthorizationMigrationStatus } from "./journal/read-authorization-migration-status.js";
import { runAuthorizationMigrations, type AuthorizationMigrationsLog } from "./run-authorization-migrations.js";

const BASELINE = "0001_baseline";
const A = "20261023090000_aaaaaaaa_alpha";
const B = "20261023090000_bbbbbbbb_beta";
const JOURNAL = `definition authz/migration_journal {
  relation applied: authz/migration_version
}
definition authz/migration_version {}
definition user {}
`;
const silentLog = { info: () => undefined };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "authz-graph-"));
  const journalFolder = join(root, "authz-journal");
  const changesFolder = join(root, "authz-changes");
  mkdirSync(join(journalFolder, BASELINE), { recursive: true });
  mkdirSync(changesFolder);
  writeFileSync(join(journalFolder, BASELINE, "schema.zed"), JOURNAL);
  const store = new RetryBackfillStore({ initialSchema: JOURNAL });
  store.appliedMarkers.push(BASELINE);
  return { root, journalFolder, changesFolder, store };
}

function writeChange(
  folder: string,
  id: string,
  options: {
    dependsOn?: readonly string[];
    name?: string;
    before?: string | null;
    after?: string | null;
    hooks?: string;
  } = {},
) {
  const name = options.name ?? `test/${id === A ? "alpha" : "beta"}`;
  mkdirSync(join(folder, id), { recursive: true });
  writeFileSync(
    join(folder, id, "patch.json"),
    JSON.stringify({
      id,
      legacyHead: BASELINE,
      dependsOn: options.dependsOn ?? [BASELINE],
      definitions: [
        {
          name,
          before: options.before ?? null,
          after: options.after === undefined ? `definition ${name} { relation owner: user }` : options.after,
        },
      ],
    }),
  );
  writeFileSync(join(folder, id, "migration.ts"), options.hooks ?? "export const migration = {};\n");
}

function run(input: ReturnType<typeof fixture>, log: AuthorizationMigrationsLog = silentLog) {
  return runAuthorizationMigrations({
    journal: [{ id: BASELINE }],
    journalFolder: input.journalFolder,
    changesFolder: input.changesFolder,
    store: input.store,
    log,
  });
}

describe("authorization definition changes", () => {
  it("counts definition changes in completion records and excludes bookkeeping markers", async () => {
    const input = fixture();
    writeChange(input.changesFolder, A);
    const records: object[] = [];
    const log = {
      info: (context: object) => {
        records.push(context);
      },
    };
    await run(input, log);
    expect(records.at(-1)).toMatchObject({
      event: "authorization.migrate.complete",
      applied: 1,
      alreadyApplied: 1,
    });
    await run(input, log);
    expect(records.at(-1)).toMatchObject({
      event: "authorization.migrate.complete",
      applied: 0,
      alreadyApplied: 2,
    });
  });

  it("counts recovery of an applied change's leftover started marker as cleanup only", async () => {
    const input = fixture();
    writeChange(input.changesFolder, A);
    input.store.failNextStartedDelete = true;
    await expect(run(input)).rejects.toThrow("started marker cleanup unavailable");
    const records: object[] = [];
    await run(input, {
      info: (context) => {
        records.push(context);
      },
    });
    expect(records).toContainEqual({
      event: "authorization.change.complete",
      applied: 0,
    });
    expect(records.at(-1)).toMatchObject({
      event: "authorization.migrate.complete",
      applied: 0,
      alreadyApplied: 2,
    });
    expect(input.store.appliedMarkers.some((marker) => marker.startsWith("authz_started_"))).toBe(false);
  });

  it("applies a later independent change before an earlier sibling without losing either definition", async () => {
    const input = fixture();
    writeChange(input.changesFolder, B);
    await run(input);
    expect(await input.store.readSchema()).toContain("test/beta");

    writeChange(input.changesFolder, A);
    await run(input);
    expect(await input.store.readSchema()).toContain("test/alpha");
    expect(await input.store.readSchema()).toContain("test/beta");
    const writes = input.store.operations.length;
    await run(input);
    expect(input.store.operations).toHaveLength(writes);
  });

  it("orders a dependent change after its prerequisite regardless of timestamps", async () => {
    const input = fixture();
    writeChange(input.changesFolder, B);
    writeChange(input.changesFolder, A, {
      name: "test/beta",
      before: "definition test/beta { relation owner: user }",
      after: "definition test/beta { relation owner: user permission view = owner }",
      dependsOn: [B],
    });
    await run(input);
    expect(await input.store.readSchema()).toContain("permission view");
  });

  it("refuses divergent edits to one definition before writing any schema or markers", async () => {
    const input = fixture();
    writeChange(input.changesFolder, A, { name: "test/shared" });
    writeChange(input.changesFolder, B, { name: "test/shared" });
    await expect(run(input)).rejects.toMatchObject({
      code: "AUTHZ_CHANGE_CONFLICT",
    });
    expect(input.store.operations).toEqual([]);
  });

  it("refuses missing prerequisites before touching the store", async () => {
    const input = fixture();
    writeChange(input.changesFolder, A, { dependsOn: [B] });
    await expect(run(input)).rejects.toMatchObject({
      code: "AUTHZ_CHANGE_DEPENDENCY",
    });
    expect(input.store.operations).toEqual([]);
  });

  it("refuses dependency cycles before touching the store", async () => {
    const input = fixture();
    writeChange(input.changesFolder, A, { dependsOn: [B] });
    writeChange(input.changesFolder, B, { dependsOn: [A] });
    await expect(run(input)).rejects.toMatchObject({
      code: "AUTHZ_CHANGE_DEPENDENCY",
    });
    expect(input.store.operations).toEqual([]);
  });

  it("refuses edits to applied change content", async () => {
    const input = fixture();
    writeChange(input.changesFolder, A);
    await run(input);
    writeFileSync(
      join(input.changesFolder, A, "migration.ts"),
      "export const migration = {}; // different immutable content\n",
    );
    await expect(run(input)).rejects.toMatchObject({
      code: "AUTHZ_CHANGE_CHECKSUM",
    });
  });

  it("seals the immutable legacy prefix when activating graph migrations", async () => {
    const input = fixture();
    writeChange(input.changesFolder, A);
    await run(input);
    writeFileSync(
      join(input.journalFolder, BASELINE, "migration.ts"),
      "export const migration = { id: '0001_baseline' };\n",
    );
    await expect(run(input)).rejects.toMatchObject({
      code: "AUTHZ_CHANGE_CHECKSUM",
    });
  });

  it("refuses quoted literals rather than normalizing meaningful literal content", async () => {
    const input = fixture();
    writeChange(input.changesFolder, A, {
      after: 'definition test/alpha { permission value = "two words" }',
    });
    await expect(run(input)).rejects.toMatchObject({
      code: "AUTHZ_CHANGE_INVALID",
    });
    expect(input.store.operations).toEqual([]);
  });

  it("makes the snapshot-only runner refuse a store carrying graph markers", async () => {
    const input = fixture();
    writeChange(input.changesFolder, A);
    await run(input);
    await expect(
      runAuthorizationMigrations({
        journal: [{ id: BASELINE }],
        journalFolder: input.journalFolder,
        store: input.store,
        log: silentLog,
      }),
    ).rejects.toThrow(/ahead|does not contain/i);
  });

  it("refuses live schema drift even when all graph changes have applied", async () => {
    const input = fixture();
    writeChange(input.changesFolder, A);
    await run(input);
    await input.store.writeSchema(`${await input.store.readSchema()}\ndefinition test/drift {}`);
    await expect(run(input)).rejects.toMatchObject({
      code: "AUTHZ_CHANGE_DRIFT",
    });
  });

  it("refuses a patch that would rewrite the journal definitions", async () => {
    const input = fixture();
    writeChange(input.changesFolder, A, {
      name: "authz/migration_journal",
      before: "definition authz/migration_journal { relation applied: authz/migration_version }",
      after: "definition authz/migration_journal {}",
    });
    await expect(run(input)).rejects.toMatchObject({
      code: "AUTHZ_CHANGE_INVALID",
    });
    expect(input.store.operations).toEqual([]);
  });

  it("has deterministic input files for before-and-after conflict measurements", () => {
    const input = fixture();
    writeChange(input.changesFolder, A);
    writeChange(input.changesFolder, B);
    const first = readFileSync(join(input.changesFolder, A, "patch.json"), "utf8");
    const second = readFileSync(join(input.changesFolder, B, "patch.json"), "utf8");
    expect(first).toContain(`"dependsOn":["${BASELINE}"]`);
    expect(second).toContain(`"dependsOn":["${BASELINE}"]`);
    expect(first).not.toEqual(second);
  });

  it("resumes a failed backfill after its schema write and clears the durable started marker", async () => {
    const input = fixture();
    writeChange(input.changesFolder, A, {
      hooks: `export const migration = {
        beforeSchemaWrite: async (client) => { await client.deleteRelationships({ resourceType: "test/retired" }); },
        afterSchemaWrite: async (client) => { await client.writeRelationships([{ resource: { type: "test/alpha", id: "one" }, relation: "owner", subject: { type: "user", id: "alice" } }]); },
      };`,
    });
    input.store.failBackfillOnce = true;
    await expect(run(input)).rejects.toThrow("backfill unavailable");
    expect(input.store.appliedMarkers.some((id) => id.startsWith("authz_started_"))).toBe(true);
    await expect(readAuthorizationMigrationStatus(input)).resolves.toEqual({
      shippedIds: [BASELINE, A],
      appliedIds: [BASELINE],
    });
    const writes = input.store.operations.filter((operation) => operation.startsWith("writeSchema:")).length;
    await run(input);
    expect(input.store.operations.filter((operation) => operation.startsWith("writeSchema:"))).toHaveLength(writes);
    expect(input.store.operations.filter((operation) => operation === "delete:test/retired")).toHaveLength(1);
    expect(input.store.operations).toContain("write:test/alpha:one:owner:alice");
    expect(input.store.appliedMarkers.some((id) => id.startsWith("authz_started_"))).toBe(false);
  });

  it("refuses unrecorded post-write schema drift during a backfill retry", async () => {
    const input = fixture();
    writeChange(input.changesFolder, A, {
      hooks: `export const migration = { afterSchemaWrite: async (client) => { await client.writeRelationships([{ resource: { type: "test/alpha", id: "one" }, relation: "owner", subject: { type: "user", id: "alice" } }]); } };`,
    });
    input.store.failBackfillOnce = true;
    await expect(run(input)).rejects.toThrow("backfill unavailable");
    await input.store.writeSchema(`${await input.store.readSchema()}\ndefinition test/unrecorded {}`);
    await expect(run(input)).rejects.toMatchObject({
      code: "AUTHZ_CHANGE_DRIFT",
    });
  });

  it("reports empty and legacy journals without requiring a changes directory", async () => {
    const input = fixture();
    rmSync(input.changesFolder, { recursive: true });
    await expect(readAuthorizationMigrationStatus(input)).resolves.toEqual({
      shippedIds: [BASELINE],
      appliedIds: [BASELINE],
    });
    rmSync(join(input.journalFolder, BASELINE), { recursive: true });
    input.store.appliedMarkers.length = 0;
    await expect(readAuthorizationMigrationStatus(input)).resolves.toEqual({
      shippedIds: [],
      appliedIds: [],
    });
  });

  it("reports logical change identities and hides checksums, protocol and in-progress markers", async () => {
    const input = fixture();
    writeChange(input.changesFolder, A);
    await run(input);
    await expect(readAuthorizationMigrationStatus(input)).resolves.toEqual({
      shippedIds: [BASELINE, A],
      appliedIds: [BASELINE, A].sort(),
    });
  });

  it("reports an applied change absent from the build as ahead using its logical identity", async () => {
    const input = fixture();
    writeChange(input.changesFolder, A);
    await run(input);
    rmSync(join(input.changesFolder, A), { recursive: true });
    await expect(readAuthorizationMigrationStatus(input)).resolves.toEqual({
      shippedIds: [BASELINE],
      appliedIds: [BASELINE, A].sort(),
    });
    await expect(run(input)).rejects.toThrow(/ahead/);
  });

  it("reads status without evaluating relationship hooks and refuses missing entry source", async () => {
    const input = fixture();
    writeChange(input.changesFolder, A, {
      hooks: "throw new Error('hooks cannot run during status');",
    });
    await expect(readAuthorizationMigrationStatus(input)).resolves.toEqual({
      shippedIds: [BASELINE, A],
      appliedIds: [BASELINE],
    });
    rmSync(join(input.changesFolder, A, "migration.ts"));
    await expect(readAuthorizationMigrationStatus(input)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

class RetryBackfillStore extends FakeSchemaStore {
  failBackfillOnce = false;
  failNextStartedDelete = false;

  override deleteExactRelationship(fact: RelationshipWrite): Promise<string> {
    if (this.failNextStartedDelete && fact.subject.id.startsWith("authz_started_")) {
      this.failNextStartedDelete = false;
      return Promise.reject(new Error("started marker cleanup unavailable"));
    }
    return super.deleteExactRelationship(fact);
  }

  override writeRelationships(writes: readonly RelationshipWrite[]): Promise<string> {
    if (this.failBackfillOnce && writes.some((write) => write.resource.type === "test/alpha")) {
      this.failBackfillOnce = false;
      return Promise.reject(new Error("backfill unavailable"));
    }
    return super.writeRelationships(writes);
  }
}
