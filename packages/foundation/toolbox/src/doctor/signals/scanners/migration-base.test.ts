/**
 * The base line the migration signals judge against, and what they do without
 * one.
 *
 * The corpus cases show a branch past `origin/main`. What they cannot show is
 * a repository with neither `origin/main` nor `main`: there the signals read
 * the whole history instead and must say so, because a fallback nobody hears
 * about reads as a measurement it is not. A base the caller names wins over
 * both defaults.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { environmentWithoutGitVariables } from "../../../verification/git-environment.js";
import { createDoctorContext } from "../../doctor-context.js";
import { runDoctorSignals } from "../../doctor-signals.js";
import { migrationsOutOfOrderSignal } from "../disorganized-attachment/migrations-out-of-order.js";
import { migrationsEditedSignal } from "../gaslighting/migrations-edited.js";
import { NO_BASE_NOTE } from "./migration-base.js";

const JOURNAL = "packages/store/src/migrations";
const FIRST = `${JOURNAL}/20260705000000_create_orders.migration.ts`;
const OLDER = `${JOURNAL}/20260701000000_add_notes.migration.ts`;

const roots: string[] = [];

function git(root: string, commandArguments: readonly string[]): void {
  const finished = spawnSync("git", [...commandArguments], {
    cwd: root,
    encoding: "utf8",
    env: environmentWithoutGitVariables(),
  });
  if (finished.status !== 0) throw new Error(finished.stderr);
}

function commit(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  git(root, ["add", "--all", "."]);
  git(root, ["commit", "--quiet", "--message", `write ${path}`]);
}

/** A repository on `trunk`: no `origin/main`, no `main`. */
function trunkRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "dad-migration-base-"));
  roots.push(root);
  git(root, ["init", "--quiet", "-b", "trunk"]);
  git(root, ["config", "user.name", "Dad Fixture"]);
  git(root, ["config", "user.email", "fixture@dads.invalid"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "core.hooksPath", ""]);
  commit(root, FIRST, 'export const up = "create table orders";\n');
  commit(root, FIRST, 'export const up = "create table orders (id)";\n');
  commit(root, OLDER, 'export const up = "alter table orders";\n');
  return root;
}

async function readBoth(root: string, base?: string) {
  const context = createDoctorContext({ root, base });
  const [edited, ordered] = await runDoctorSignals(context, [
    migrationsEditedSignal,
    migrationsOutOfOrderSignal,
  ]);
  return {
    edited: Object.fromEntries(
      [...(edited?.readings ?? [])].map(([key, one]) => [key, one.value]),
    ),
    ordered: Object.fromEntries(
      [...(ordered?.readings ?? [])].map(([key, one]) => [key, one.value]),
    ),
    notes: [...(edited?.notes ?? []), ...(ordered?.notes ?? [])],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the migration base line", () => {
  it("reads the whole history without a base, and says so", async () => {
    const read = await readBoth(trunkRepository());
    expect(read).toStrictEqual({
      edited: { [FIRST]: 1, [OLDER]: 0 },
      ordered: { [FIRST]: 0, [OLDER]: 1 },
      notes: [NO_BASE_NOTE, NO_BASE_NOTE],
    });
  });

  it("judges only what is past a base the caller names", async () => {
    const read = await readBoth(trunkRepository(), "trunk~2");
    expect(read).toStrictEqual({
      edited: { [FIRST]: 1, [OLDER]: 0 },
      ordered: { [FIRST]: 0, [OLDER]: 1 },
      notes: [],
    });
  });

  it("freezes nothing a checkout sitting on its base already holds", async () => {
    const read = await readBoth(trunkRepository(), "trunk");
    expect(read).toStrictEqual({
      edited: { [FIRST]: 0, [OLDER]: 0 },
      ordered: { [FIRST]: 0, [OLDER]: 0 },
      notes: [],
    });
  });
});
