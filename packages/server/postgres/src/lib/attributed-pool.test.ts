import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTOR_SETTING,
  runWithAuditActor,
  currentAuditActor,
  systemActor,
  type AuditActor,
} from "@dads-framework/core/audit-actor";
import {
  AUDIT_ACTOR_STAMP_SQL,
  checkOutStampedClient,
  createAttributedPool,
  stampAuditActor,
  type AuditActorSource,
  type StampableClient,
} from "./attributed-pool.js";

const REQUEST_ID = "01990000-0000-7000-8000-000000000001";
const USER_ACTOR: AuditActor = {
  kind: "user",
  id: "user-1",
  requestId: REQUEST_ID,
};

type Statement = { readonly text: string; readonly values: string[] };

/** A checked-out client that records what was asked of it and answers nothing. */
class RecordingClient implements StampableClient {
  readonly statements: Statement[] = [];
  readonly releasedWith: (Error | undefined)[] = [];

  constructor(private readonly refuseStamp?: Error) {}

  query(text: string, values: string[]): Promise<unknown> {
    this.statements.push({ text, values });
    if (this.refuseStamp !== undefined && text === AUDIT_ACTOR_STAMP_SQL) {
      return Promise.reject(this.refuseStamp);
    }
    return Promise.resolve({ rows: [] });
  }

  release(error?: Error): void {
    this.releasedWith.push(error);
  }

  get texts(): string[] {
    return this.statements.map((statement) => statement.text);
  }
}

function sourceOf(actor: AuditActor | undefined): AuditActorSource {
  return () => actor;
}

describe("stampAuditActor", () => {
  // Spelled out rather than compared to itself: the third argument is
  // `is_local`, and `true` would end the attribution with the statement that
  // set it. Almost every write in this repository is a lone `insert` outside
  // any transaction, so `SET LOCAL` semantics would refuse all of them.
  it("stamps at session level, so the actor survives the statement that set it", () => {
    expect(AUDIT_ACTOR_STAMP_SQL).toBe("select set_config($1, $2, false)");
  });

  it("writes the current actor into the setting the trigger reads", async () => {
    const client = new RecordingClient();

    await stampAuditActor(client, sourceOf(USER_ACTOR));

    expect(client.statements).toEqual([
      {
        text: AUDIT_ACTOR_STAMP_SQL,
        values: [
          AUDIT_ACTOR_SETTING,
          JSON.stringify({ kind: "user", id: "user-1", requestId: REQUEST_ID }),
        ],
      },
    ]);
  });

  it("stamps the empty string when no actor is in force, which is what the trigger refuses", async () => {
    const client = new RecordingClient();

    await stampAuditActor(client, sourceOf(undefined));

    expect(client.statements).toEqual([
      { text: AUDIT_ACTOR_STAMP_SQL, values: [AUDIT_ACTOR_SETTING, ""] },
    ]);
  });

  it("reads the source at stamp time, so a checkout gets the actor of the task that asked for it", async () => {
    const client = new RecordingClient();

    await runWithAuditActor(USER_ACTOR, () =>
      stampAuditActor(client, currentAuditActor),
    );
    await stampAuditActor(client, currentAuditActor);

    expect(client.statements.map((statement) => statement.values[1])).toEqual([
      JSON.stringify({ kind: "user", id: "user-1", requestId: REQUEST_ID }),
      "",
    ]);
  });
});

describe("checkOutStampedClient", () => {
  it("stamps before the caller's first statement", async () => {
    const client = new RecordingClient();

    const checkedOut = await checkOutStampedClient(
      () => Promise.resolve(client),
      sourceOf(USER_ACTOR),
    );
    await checkedOut.query("insert into organizations (name) values ($1)", [
      "Acme",
    ]);

    expect(client.texts).toEqual([
      AUDIT_ACTOR_STAMP_SQL,
      "insert into organizations (name) values ($1)",
    ]);
  });

  it("costs exactly one statement per checkout", async () => {
    const client = new RecordingClient();

    await checkOutStampedClient(
      () => Promise.resolve(client),
      sourceOf(systemActor("test", "test")),
    );

    expect(client.statements).toHaveLength(1);
  });

  it("re-stamps on the next checkout, so a released client never carries the last actor", async () => {
    const client = new RecordingClient();
    let actor: AuditActor | undefined = USER_ACTOR;

    await checkOutStampedClient(
      () => Promise.resolve(client),
      () => actor,
    );
    actor = undefined;
    await checkOutStampedClient(
      () => Promise.resolve(client),
      () => actor,
    );

    expect(client.statements.map((statement) => statement.values[1])).toEqual([
      JSON.stringify({ kind: "user", id: "user-1", requestId: REQUEST_ID }),
      "",
    ]);
  });

  it("releases the client WITH the error when the stamp fails, so pg destroys it", async () => {
    const refusal = new Error("connection lost mid-stamp");
    const client = new RecordingClient(refusal);

    await expect(
      checkOutStampedClient(
        () => Promise.resolve(client),
        sourceOf(USER_ACTOR),
      ),
    ).rejects.toThrow(refusal);
    expect(client.releasedWith).toEqual([refusal]);
  });

  it("does not release a client it never got", async () => {
    const refusal = new Error("pool exhausted");

    await expect(
      checkOutStampedClient(() => Promise.reject(refusal), sourceOf(undefined)),
    ).rejects.toThrow(refusal);
  });
});

describe("AttributedPool", () => {
  it("is a pg.Pool, which is how Drizzle decides to run a transaction on ONE client", async () => {
    const pool = createAttributedPool({}, sourceOf(USER_ACTOR));

    expect(pool).toBeInstanceOf(Pool);

    await pool.end();
  });

  // `pg.Pool.prototype.query` is connect → query → release. Inheriting it is
  // what stamps the single-statement path — the path almost every write in
  // this repository takes — so an override here would be a silent hole.
  it("overrides only checkout so inherited queries are attributed too", async () => {
    const pool = createAttributedPool({}, sourceOf(USER_ACTOR));
    try {
      // Query lookup must continue to pg.Pool.prototype.
      const prototype: unknown = Object.getPrototypeOf(pool);
      if (typeof prototype !== "object" || prototype === null) {
        throw new Error("Expected a pool subclass prototype");
      }
      expect(Object.getPrototypeOf(prototype)).toBe(Pool.prototype);
      expect(Object.getOwnPropertyNames(prototype).sort()).toEqual([
        "connect",
        "constructor",
      ]);
    } finally {
      await pool.end();
    }
  });
});
