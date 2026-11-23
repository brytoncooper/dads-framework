/** Proves `sequential-authz-writes` allows inserts + `writeRelationships` inside protected Postgres transactions. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDoctorContext } from "../../doctor-context.js";
import { sequentialAuthzWritesSignal } from "./sequential-authz-writes.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workspaceWith(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "dad-seq-authz-"));
  temporaryDirectories.push(root);
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return root;
}

describe("sequential-authz-writes signal", () => {
  it("does not flag writeRelationships inside protected Postgres transactions", async () => {
    const root = workspaceWith({
      "src/protected-creates.ts": `
type Tx = { insert(table: string): { values(row: object): Promise<void> } };
type Auth = { writeRelationships(facts: readonly object[]): Promise<void> };
declare function withProtectedDrizzleTransaction(
  deps: object,
  run: (ctx: { tx: Tx; authorization: Auth }) => Promise<void>,
): Promise<void>;
declare function withProtectedPgTransaction(
  deps: object,
  run: (ctx: { tx: Tx; authorization: Auth }) => Promise<void>,
): Promise<void>;
declare function withProtectedPostgresTransaction(
  deps: object,
  run: (ctx: { tx: Tx; authorization: Auth }) => Promise<void>,
): Promise<void>;
declare function writeWithPermission(
  guard: object,
  run: (tx: Tx, authorization: Auth) => Promise<void>,
): Promise<void>;

export async function createWithDrizzle() {
  return withProtectedDrizzleTransaction({}, async ({ tx, authorization }) => {
    await tx.insert("notes").values({ id: "1" });
    await authorization.writeRelationships([{ resource: "1", relation: "owner" }]);
  });
}

export async function createWithPg() {
  return withProtectedPgTransaction({}, async ({ tx, authorization }) => {
    await tx.insert("notes").values({ id: "1" });
    await authorization.writeRelationships([{ resource: "1", relation: "owner" }]);
  });
}

export async function createWithPostgres() {
  return withProtectedPostgresTransaction({}, async ({ tx, authorization }) => {
    await tx.insert("notes").values({ id: "1" });
    await authorization.writeRelationships([{ resource: "1", relation: "owner" }]);
  });
}

export async function createWithPermission() {
  return writeWithPermission({}, async (tx, authorization) => {
    await tx.insert("notes").values({ id: "1" });
    await authorization.writeRelationships([{ resource: "1", relation: "owner" }]);
  });
}
`,
      "src/unprotected-create.ts": `
type Db = { insert(table: string): { values(row: object): Promise<void> } };
type Auth = { writeRelationships(facts: readonly object[]): Promise<void> };

export async function createSeparately(db: Db, auth: Auth) {
  await db.insert("notes").values({ id: "1" });
  await auth.writeRelationships([{ resource: "1", relation: "owner" }]);
}
`,
    });

    const readings = await sequentialAuthzWritesSignal.run(createDoctorContext({ root }));
    expect(readings.get("src/protected-creates.ts")?.value).toBe(0);
    expect(readings.get("src/unprotected-create.ts")?.value).toBe(1);
  });
});
