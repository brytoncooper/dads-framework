import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  applyAuthorizationDefinitionPatches,
  authorizationChangeFrontier,
  type AuthorizationSchemaChange,
  canonicalAuthorizationSchema,
  composeAuthorizationChanges,
  diffAuthorizationDefinitions,
  orderAuthorizationChanges,
} from "../../definition-changes.mjs";
import { loadAuthorizationChangeFiles } from "../journal/authorization-change-files.js";
import {
  classifySchemaDiff,
  type SchemaDiffClassification,
} from "../logic/classify-schema-diff.js";

export type ScaffoldAuthorizationChangeInput = {
  readonly journalFolder: string;
  readonly changesFolder: string;
  readonly composedSchema: string;
  readonly slug: string;
  readonly now: Date;
  readonly nonce: string;
};

export type ScaffoldAuthorizationChangeResult =
  | { readonly action: "up-to-date"; readonly id: string }
  | {
      readonly action: "created";
      readonly id: string;
      readonly classification: SchemaDiffClassification;
    };

export async function scaffoldAuthorizationChange(
  input: ScaffoldAuthorizationChangeInput,
): Promise<ScaffoldAuthorizationChangeResult> {
  if (
    !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(input.slug) ||
    !/^[a-f0-9]{8}$/.test(input.nonce) ||
    !Number.isFinite(input.now.getTime())
  )
    throw new Error(
      "an authorization change needs a lowercase underscore slug, valid UTC time and eight hexadecimal nonce characters",
    );
  const legacyFolders = (
    await readdir(input.journalFolder, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory() && /^\d{4}_/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const legacyHead = legacyFolders.at(-1);
  if (legacyHead === undefined)
    throw new Error(
      "authorization changes require an immutable journal baseline",
    );
  const baseline = await readFile(
    join(input.journalFolder, legacyHead, "schema.zed"),
    "utf8",
  );
  await mkdir(input.changesFolder, { recursive: true });
  const changes = await loadAuthorizationChangeFiles(input.changesFolder);
  const ordered = orderAuthorizationChanges(changes, legacyHead);
  const previous = composeAuthorizationChanges(baseline, ordered);
  if (
    canonicalAuthorizationSchema(previous) ===
    canonicalAuthorizationSchema(input.composedSchema)
  )
    return { action: "up-to-date", id: ordered.at(-1)?.id ?? legacyHead };
  const timestamp = input.now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const id = `${timestamp}_${input.nonce}_${input.slug}`;
  const change: AuthorizationSchemaChange = {
    id,
    legacyHead,
    dependsOn: authorizationChangeFrontier(ordered, legacyHead),
    definitions: diffAuthorizationDefinitions(previous, input.composedSchema),
  };
  const next = applyAuthorizationDefinitionPatches(previous, change);
  const classification = classifySchemaDiff(previous, next);
  const entryFolder = join(input.changesFolder, id);
  await mkdir(entryFolder);
  await writeFile(
    join(entryFolder, "patch.json"),
    `${JSON.stringify(change, null, 2)}\n`,
  );
  await writeFile(
    join(entryFolder, "migration.ts"),
    hooksContent(id, classification),
  );
  return { action: "created", id, classification };
}

function hooksContent(
  id: string,
  classification: SchemaDiffClassification,
): string {
  const header =
    'import type { AuthorizationChangeHooks } from "@dads-framework/authorization-migration";\n\n';
  if (classification.kind === "additive")
    return `${header}export const migration: AuthorizationChangeHooks = {};\n`;
  return `${header}export const migration: AuthorizationChangeHooks = {\n  beforeSchemaWrite: () => {\n    throw new Error(${JSON.stringify(`TODO(${id}): preserve access and clear relationships for: ${classification.removals.join("; ")}`)});\n  },\n};\n`;
}
