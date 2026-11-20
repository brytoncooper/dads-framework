import { describe, expect, it } from "vitest";

import type { RelationshipWrite } from "@dads-framework/access/runtime";

import { authorizationSchemaFingerprint } from "../definition-changes.mjs";
import { FakeSchemaStore } from "../testing/fake-schema-store.js";
import type { LoadedAuthorizationChange } from "./journal/load-authorization-changes.js";
import {
  prepareAuthorizationChanges,
  runPreparedAuthorizationChanges,
} from "./run-authorization-changes.js";

const BASELINE = "0001_baseline";
const ID = "20261023090000_aaaaaaaa_alpha";
const SCHEMA = `definition authz/migration_journal { relation applied: authz/migration_version }
definition authz/migration_version {}
definition user {}`;

function change(
  overrides: Partial<LoadedAuthorizationChange> = {},
): LoadedAuthorizationChange {
  return {
    id: ID,
    legacyHead: BASELINE,
    dependsOn: [BASELINE],
    checksum: "a".repeat(64),
    definitions: [
      {
        name: "test/alpha",
        before: null,
        after: "definition test/alpha { relation owner: user }",
      },
    ],
    ...overrides,
  };
}

class RetryStartedMarkerStore extends FakeSchemaStore {
  failNextStartedWrite = false;

  override writeRelationships(
    writes: readonly RelationshipWrite[],
  ): Promise<string> {
    if (
      this.failNextStartedWrite &&
      writes.some((write) => write.subject.id.startsWith("authz_started_"))
    ) {
      this.failNextStartedWrite = false;
      return Promise.reject(new Error("started marker unavailable"));
    }
    return super.writeRelationships(writes);
  }
}

function fixture() {
  const store = new RetryStartedMarkerStore({ initialSchema: SCHEMA });
  store.appliedMarkers.push(BASELINE);
  const events: object[] = [];
  const log = {
    info: (context: object) => {
      events.push(context);
    },
  };
  const run = async (entry: LoadedAuthorizationChange) =>
    runPreparedAuthorizationChanges(
      prepareAuthorizationChanges(
        [{ id: BASELINE, number: 1, schema: SCHEMA }],
        [entry],
        store.appliedMarkers,
        "f".repeat(64),
      ),
      { journal: [{ id: BASELINE }], journalFolder: "unused", store, log },
    );
  return { store, events, run };
}

describe("authorization change recovery", () => {
  it("retries corrected hook and patch content while the live schema remains at its recorded before state", async () => {
    const input = fixture();
    const unfinished = change({
      beforeSchemaWrite: () =>
        Promise.reject(new Error("relationship step unfinished")),
    });
    await expect(input.run(unfinished)).rejects.toThrow(
      "relationship step unfinished",
    );
    const corrected = change({
      checksum: "b".repeat(64),
      definitions: [
        {
          name: "test/alpha",
          before: null,
          after:
            "definition test/alpha { relation owner: user permission view = owner }",
        },
      ],
    });
    await expect(input.run(corrected)).resolves.toBe(1);
    expect(await input.store.readSchema()).toContain("permission view");
    expect(input.store.appliedMarkers).toContain(
      `authz_applied_${ID}_${corrected.checksum}`,
    );
    expect(
      input.store.appliedMarkers.some((marker) =>
        marker.startsWith("authz_started_"),
      ),
    ).toBe(false);
  });

  it("allows correction after a rejected schema write without dropping the immutable barrier", async () => {
    const input = fixture();
    input.store.failOnNextSchemaWrite("schema write unavailable");
    await expect(input.run(change())).rejects.toThrow(
      "schema write unavailable",
    );
    const barrier = input.store.appliedMarkers.find((marker) =>
      marker.startsWith("authz_graph_"),
    );
    await expect(input.run(change({ checksum: "b".repeat(64) }))).resolves.toBe(
      1,
    );
    expect(input.store.appliedMarkers).toContain(barrier);
  });

  it("can retry if writing the replacement started marker fails after retiring the stale marker", async () => {
    const input = fixture();
    await expect(
      input.run(
        change({
          beforeSchemaWrite: () => Promise.reject(new Error("unfinished")),
        }),
      ),
    ).rejects.toThrow("unfinished");
    input.store.failNextStartedWrite = true;
    const corrected = change({ checksum: "b".repeat(64) });
    await expect(input.run(corrected)).rejects.toThrow(
      "started marker unavailable",
    );
    expect(await input.store.readSchema()).toBe(SCHEMA);
    expect(
      input.store.appliedMarkers.some((marker) =>
        marker.startsWith("authz_started_"),
      ),
    ).toBe(false);
    await expect(input.run(corrected)).resolves.toBe(1);
  });

  it("records the corrected checksum before a post-write failure and resumes without replaying its before hook", async () => {
    const input = fixture();
    await expect(
      input.run(
        change({
          beforeSchemaWrite: () => Promise.reject(new Error("unfinished")),
        }),
      ),
    ).rejects.toThrow("unfinished");
    let beforeCalls = 0;
    let failBackfill = true;
    const corrected = change({
      checksum: "b".repeat(64),
      beforeSchemaWrite: () => {
        beforeCalls += 1;
        return Promise.resolve();
      },
      afterSchemaWrite: () => {
        if (failBackfill) {
          failBackfill = false;
          return Promise.reject(new Error("backfill unavailable"));
        }
        return Promise.resolve();
      },
    });
    await expect(input.run(corrected)).rejects.toThrow("backfill unavailable");
    expect(
      input.store.appliedMarkers.some((marker) =>
        marker.startsWith(`authz_started_${ID}_${corrected.checksum}_`),
      ),
    ).toBe(true);
    await expect(input.run(corrected)).resolves.toBe(1);
    expect(beforeCalls).toBe(1);
  });

  it("refuses corrected content after the live schema advanced and permits retrying the exact recorded change", async () => {
    const input = fixture();
    let failBackfill = true;
    const original = change({
      afterSchemaWrite: () => {
        if (failBackfill) {
          failBackfill = false;
          return Promise.reject(new Error("backfill unavailable"));
        }
        return Promise.resolve();
      },
    });
    await expect(input.run(original)).rejects.toThrow("backfill unavailable");
    const operations = [...input.store.operations];
    await expect(
      input.run(change({ checksum: "b".repeat(64) })),
    ).rejects.toMatchObject({ code: "AUTHZ_CHANGE_CHECKSUM" });
    expect(input.store.operations).toEqual(operations);
    await input.run(original);
  });

  it("preserves the started marker when live schema drift makes a correction unsafe", async () => {
    const input = fixture();
    await expect(
      input.run(
        change({
          beforeSchemaWrite: () => Promise.reject(new Error("unfinished")),
        }),
      ),
    ).rejects.toThrow("unfinished");
    await input.store.writeSchema(`${SCHEMA}\ndefinition test/drift {}`);
    const markers = [...input.store.appliedMarkers];
    await expect(
      input.run(change({ checksum: "b".repeat(64) })),
    ).rejects.toMatchObject({ code: "AUTHZ_CHANGE_DRIFT" });
    expect(input.store.appliedMarkers).toEqual(markers);
  });

  it("refuses a changed started checksum for an already-applied change before cleanup", async () => {
    const input = fixture();
    await input.run(change());
    const after = await input.store.readSchema();
    input.store.appliedMarkers.push(
      `authz_started_${ID}_${"b".repeat(64)}_${authorizationSchemaFingerprint(SCHEMA)}_${authorizationSchemaFingerprint(after)}`,
    );
    const operations = [...input.store.operations];
    await expect(input.run(change())).rejects.toMatchObject({
      code: "AUTHZ_CHANGE_CHECKSUM",
    });
    expect(input.store.operations).toEqual(operations);
  });

  it("retries idempotent before hooks when a schema-neutral change has no distinct post-write fingerprint", async () => {
    const input = fixture();
    let calls = 0;
    const entry = change({
      definitions: [],
      beforeSchemaWrite: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("unfinished"))
          : Promise.resolve();
      },
    });
    await expect(input.run(entry)).rejects.toThrow("unfinished");
    await input.run(entry);
    expect(calls).toBe(2);
  });
});
