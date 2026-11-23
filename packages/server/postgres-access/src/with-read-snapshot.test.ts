import { actor, compileAccess, resource } from "@dads-framework/access";
import { describe, expect, it } from "vitest";
import { PostgresAuthorization } from "./postgres-authorization.js";
import type {
  PgClientLike,
  PgPoolLike,
  PostgresQuery,
  PostgresQueryResult,
} from "./postgres-types.js";
import { withReadSnapshot } from "./with-read-snapshot.js";

const user = actor("user");
const workspace = resource("workspace", {
  roles: { member: user },
  can: ({ member }) => ({ view: member }),
  children: {
    document: {
      inherit: "all",
      roles: { editor: user },
      can: ({ editor }) => ({ edit: editor }),
    },
  },
});
const model = compileAccess([workspace]);

type RecordedCall = {
  readonly text: string;
  readonly values?: readonly unknown[];
};

function createFakePgPool(options?: {
  readonly queryResult?: (query: string | PostgresQuery) => PostgresQueryResult;
}): {
  readonly pool: PgPoolLike;
  readonly queries: RecordedCall[];
  readonly released: (boolean | undefined)[];
} {
  const queries: RecordedCall[] = [];
  const released: (boolean | undefined)[] = [];
  let status: "I" | "T" | "E" = "I";

  const client: PgClientLike = {
    query(query: string | PostgresQuery): Promise<PostgresQueryResult> {
      const text = typeof query === "string" ? query : query.text;
      const values = typeof query === "string" ? undefined : query.values;
      queries.push({ text, ...(values === undefined ? {} : { values }) });
      if (text.startsWith("BEGIN")) status = "T";
      if (text === "COMMIT" || text === "ROLLBACK") status = "I";
      if (options?.queryResult !== undefined) {
        return Promise.resolve(options.queryResult(query));
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release(err?: boolean | Error) {
      released.push(err === undefined ? undefined : Boolean(err));
    },
    getTransactionStatus() {
      return status;
    },
  };

  return {
    pool: {
      connect: () => Promise.resolve(client),
      query: (query) => client.query(query),
    },
    queries,
    released,
  };
}

describe("withReadSnapshot and typed permission handles", () => {
  it("opens REPEATABLE READ READ ONLY, scopes authorization, commits, and expires handle", async () => {
    const fake = createFakePgPool({
      queryResult(query) {
        const text = typeof query === "string" ? query : query.text;
        if (text.includes("SELECT")) {
          return { rows: [{ allowed: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    });
    const authorization = new PostgresAuthorization({
      model,
      namespace: "app",
      executor: {
        query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      },
    });

    let escaped: PostgresAuthorization | undefined;
    const allowed = await withReadSnapshot(
      { pool: fake.pool, authorization },
      async ({ authorization: scoped }) => {
        escaped = scoped;
        return scoped.can(
          user("alice"),
          workspace.document.permissions.edit,
          "doc-1",
        );
      },
    );

    expect(allowed).toBe(true);
    expect(fake.queries[0]?.text).toBe(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(fake.queries.at(-1)?.text).toBe("COMMIT");
    expect(fake.released).toEqual([undefined]);

    if (escaped === undefined) {
      throw new Error("Expected scoped authorization handle to be captured.");
    }
    await expect(
      escaped.can(user("alice"), workspace.document("doc-1").edit),
    ).rejects.toThrow("Protected Postgres authorization scope has ended");
  });

  it("rolls back and releases when work throws", async () => {
    const fake = createFakePgPool();
    const authorization = new PostgresAuthorization({
      model,
      namespace: "app",
      executor: { query: () => Promise.resolve({ rows: [], rowCount: 0 }) },
    });

    await expect(
      withReadSnapshot({ pool: fake.pool, authorization }, () =>
        Promise.reject(new Error("boom")),
      ),
    ).rejects.toThrow("boom");

    expect(fake.queries.map((entry) => entry.text)).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "ROLLBACK",
    ]);
    expect(fake.released).toEqual([undefined]);
  });

  it("compiles identical SQL for typed PermissionToken and explicit wire strings", () => {
    const authorization = new PostgresAuthorization({
      model,
      namespace: "app",
      executor: { query: () => Promise.resolve({ rows: [], rowCount: 0 }) },
    });

    const typed = authorization.compileFilter({
      subject: user("alice"),
      permission: workspace.document.permissions.view,
      idColumn: "doc.id",
    });
    const wire = authorization.compileFilter({
      subject: user("alice"),
      resourceType: workspace.document.wireName,
      permission: workspace.document.permissions.view.permissionName,
      idColumn: "doc.id",
    });

    expect(typed).toEqual(wire);
  });

  it("supports both DslPermissionTarget and PermissionToken + id in authorization.can", async () => {
    const seenValues: (readonly unknown[] | undefined)[] = [];
    const authorization = new PostgresAuthorization({
      model,
      namespace: "app",
      executor: {
        query(query) {
          seenValues.push(query.values);
          return Promise.resolve({ rows: [{ allowed: true }], rowCount: 1 });
        },
      },
    });

    const byTarget = await authorization.can(
      user("alice"),
      workspace.document("doc-42").edit,
    );
    const byToken = await authorization.can(
      user("alice"),
      workspace.document.permissions.edit,
      "doc-42",
    );

    expect(byTarget).toBe(true);
    expect(byToken).toBe(true);
    expect(seenValues[0]).toEqual(seenValues[1]);
  });
});
