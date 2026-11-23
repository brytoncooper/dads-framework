import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifySchemaDiff, type SchemaDiffClassification } from "../logic/classify-schema-diff.js";
import { scaffoldMigration } from "./scaffold-migration.js";

/**
 * Renumbering a branch's journal entry after main minted the same number.
 * Two PRs that each add entry NNNN collide; the second one to land
 * carries its entry aside, lets the journal match main, re-mints it with the
 * next number through the scaffolder, and restores its migration.ts body under
 * the new id. Only an entry main does not have is ever touched — entries on
 * main are immutable once DEPLOYED.
 */

export type RenumberPlan =
  | { readonly kind: "no-own-entry" }
  | { readonly kind: "already-next"; readonly entryId: string }
  | { readonly kind: "renumber"; readonly entryId: string };

const ENTRY_ID = /^(\d{4})_([a-z0-9][a-z0-9_-]*)$/;

/**
 * Decides what to renumber from two folder listings: the journal at main and
 * the journal at this branch's HEAD (already rebased on main). The branch's own
 * entries are the ones main lacks. Refuses anything it cannot renumber
 * faithfully.
 */
export function planRenumber(input: {
  readonly mainEntryIds: readonly string[];
  readonly headEntryIds: readonly string[];
}): RenumberPlan {
  const missingFromHead = input.mainEntryIds.filter((id) => !input.headEntryIds.includes(id));
  if (missingFromHead.length > 0) {
    throw new Error(
      `this branch lacks main's journal entries (${missingFromHead.join(", ")}) — ` +
        "rebase on origin/main first (`git rebase origin/main`)",
    );
  }

  const ownEntryIds = input.headEntryIds.filter((id) => !input.mainEntryIds.includes(id));
  const [ownEntryId, ...extraEntryIds] = ownEntryIds;
  if (ownEntryId === undefined) {
    return { kind: "no-own-entry" };
  }
  if (extraEntryIds.length > 0) {
    throw new Error(
      `this branch adds ${String(ownEntryIds.length)} journal entries (${ownEntryIds.join(", ")}). ` +
        "Their intermediate snapshots cannot be rebuilt on top of main faithfully, so " +
        "fold them into one: delete all but the last, merge their migration.ts steps " +
        "into it, then run this again.",
    );
  }

  const nextNumber = input.mainEntryIds.length + 1;
  return entryNumberOf(ownEntryId) === nextNumber
    ? { kind: "already-next", entryId: ownEntryId }
    : { kind: "renumber", entryId: ownEntryId };
}

/**
 * Rewrites a migration.ts body from one entry id to another. The body must
 * declare `id: "<oldId>"` exactly once; every other mention of the old id
 * (a TODO( step's message, a comment) moves with it.
 */
export function rewriteMigrationId(source: string, oldId: string, newId: string): string {
  const declarations = source.split(`id: "${oldId}"`).length - 1;
  if (declarations !== 1) {
    throw new Error(
      `expected migration.ts to declare id: "${oldId}" exactly once, found ${String(declarations)} — ` +
        "fix the entry by hand before renumbering",
    );
  }
  return source.split(oldId).join(newId);
}

export type RenumberMigrationInput = {
  readonly journalFolder: string;
  /** The branch's own entry, as `planRenumber` returned it. */
  readonly entryId: string;
  /** The freshly composed schema (`npm run authz:generate` output). */
  readonly composedSchema: string;
  /**
   * Proceed even when the entry's additive/destructive classification against
   * its new previous snapshot differs from the one it was authored against.
   */
  readonly acceptClassificationChange: boolean;
};

export type RenumberMigrationResult =
  | {
      readonly action: "renumbered";
      readonly oldId: string;
      readonly newId: string;
      readonly classification: SchemaDiffClassification;
      readonly classificationChanged: boolean;
    }
  | {
      /** Nothing was written. */
      readonly action: "classification-changed";
      readonly before: SchemaDiffClassification;
      readonly after: SchemaDiffClassification;
    }
  | {
      /** Nothing was written: main already ships this schema. */
      readonly action: "subsumed-by-main";
      readonly latestMainId: string;
    };

/**
 * Re-mints the branch's own entry with the next number. Everything is read and
 * judged before the first write; the caller guarantees a clean committed tree,
 * so a failure mid-write is recoverable with `git restore`.
 */
export async function renumberMigration(input: RenumberMigrationInput): Promise<RenumberMigrationResult> {
  const mainEntryIds = await mainEntriesBeside(input.journalFolder, input.entryId);
  const latestMainId = mainEntryIds.at(-1);
  if (latestMainId === undefined) {
    throw new Error("the journal has no entries besides this branch's own");
  }

  const before = await classificationAuthored(input.journalFolder, mainEntryIds, input.entryId);

  const latestMainSchema = await readFile(join(input.journalFolder, latestMainId, "schema.zed"), "utf8");
  if (latestMainSchema === input.composedSchema) {
    return { action: "subsumed-by-main", latestMainId };
  }

  const after = classifySchemaDiff(latestMainSchema, input.composedSchema);
  const classificationChanged = !sameClassification(before, after);
  if (classificationChanged && !input.acceptClassificationChange) {
    return { action: "classification-changed", before, after };
  }

  const newId = await remintEntry(input);
  return {
    action: "renumbered",
    oldId: input.entryId,
    newId,
    classification: after,
    classificationChanged,
  };
}

/** The verdict the entry carried when it was minted on its old base. */
async function classificationAuthored(
  journalFolder: string,
  mainEntryIds: readonly string[],
  entryId: string,
): Promise<SchemaDiffClassification> {
  return classifySchemaDiff(
    await previousSnapshotAuthoredAgainst(journalFolder, mainEntryIds, entryNumberOf(entryId)),
    await readFile(join(journalFolder, entryId, "schema.zed"), "utf8"),
  );
}

/**
 * Carries the entry's files aside, removes it, lets the scaffolder mint the
 * next number from the composed schema, and restores the carried files under
 * the new id. Returns the new id.
 */
async function remintEntry(input: RenumberMigrationInput): Promise<string> {
  const entryFolder = join(input.journalFolder, input.entryId);
  const carriedFiles = await readCarriedFiles(entryFolder);
  await rm(entryFolder, { recursive: true });

  const minted = await scaffoldMigration({
    journalFolder: input.journalFolder,
    composedSchema: input.composedSchema,
    slug: slugOf(input.entryId),
    mode: "new",
  });
  if (minted.action !== "created") {
    throw new Error(`the scaffolder did not mint a new entry (${minted.action} ${minted.id})`);
  }

  const newEntryFolder = join(input.journalFolder, minted.id);
  for (const [name, content] of carriedFiles) {
    await writeFile(
      join(newEntryFolder, name),
      name === "migration.ts" ? rewriteMigrationId(content, input.entryId, minted.id) : content,
    );
  }
  return minted.id;
}

/** The journal's entries other than the branch's own — main's, numbered 1..n. */
async function mainEntriesBeside(journalFolder: string, ownEntryId: string): Promise<readonly string[]> {
  const folders = await readdir(journalFolder, { withFileTypes: true });
  const ids = folders
    .filter((folder) => folder.isDirectory())
    .map((folder) => folder.name)
    .filter((name) => ENTRY_ID.test(name));
  if (!ids.includes(ownEntryId)) {
    throw new Error(`journal entry ${ownEntryId} has no folder to renumber`);
  }

  const mainIds = ids.filter((id) => id !== ownEntryId).sort();
  mainIds.forEach((id, index) => {
    if (entryNumberOf(id) !== index + 1) {
      throw new Error(
        `main's journal is not numbered 1..${String(mainIds.length)} (found ${id} at position ` +
          `${String(index + 1)}) — renumbering only ever moves this branch's own entry`,
      );
    }
  });
  return mainIds;
}

/**
 * The snapshot the entry was diffed against when it was minted: the one
 * numbered just below it. That entry is main's (main's entries are a superset
 * of the old base's), so it is still on disk after the rebase.
 */
async function previousSnapshotAuthoredAgainst(
  journalFolder: string,
  mainEntryIds: readonly string[],
  oldNumber: number,
): Promise<string> {
  const previousId = mainEntryIds[Math.min(oldNumber - 1, mainEntryIds.length) - 1];
  return previousId === undefined ? "" : readFile(join(journalFolder, previousId, "schema.zed"), "utf8");
}

/** Every file in the entry except its snapshot, which is re-taken. */
async function readCarriedFiles(entryFolder: string): Promise<ReadonlyMap<string, string>> {
  const items = await readdir(entryFolder, { withFileTypes: true });
  const carried = new Map<string, string>();
  for (const item of items) {
    if (!item.isFile()) {
      throw new Error(`${join(entryFolder, item.name)} is not a plain file — move it by hand`);
    }
    if (item.name === "schema.zed") continue;
    carried.set(item.name, await readFile(join(entryFolder, item.name), "utf8"));
  }
  if (!carried.has("migration.ts")) {
    throw new Error(`${entryFolder} has no migration.ts to carry`);
  }
  return carried;
}

function sameClassification(left: SchemaDiffClassification, right: SchemaDiffClassification): boolean {
  return removalsOf(left).sort().join("\n") === removalsOf(right).sort().join("\n");
}

function removalsOf(classification: SchemaDiffClassification): string[] {
  return classification.kind === "destructive" ? [...classification.removals] : [];
}

function entryNumberOf(entryId: string): number {
  const match = ENTRY_ID.exec(entryId);
  if (match === null) {
    throw new Error(`journal entry "${entryId}" is not named NNNN_slug`);
  }
  return Number(match[1]);
}

function slugOf(entryId: string): string {
  const match = ENTRY_ID.exec(entryId);
  if (match === null) {
    throw new Error(`journal entry "${entryId}" is not named NNNN_slug`);
  }
  return match[2] ?? "";
}
