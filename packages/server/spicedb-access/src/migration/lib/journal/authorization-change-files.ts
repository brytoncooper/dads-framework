import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { z } from "zod";
import {
  AUTHORIZATION_CHANGE_ID,
  AuthorizationChangeError,
  type AuthorizationSchemaChange,
} from "../../definition-changes.mjs";

const definitionPatchSchema = z
  .object({
    name: z.string().min(1),
    before: z.string().min(1).nullable(),
    after: z.string().min(1).nullable(),
  })
  .strict();
const authorizationChangeSchema = z
  .object({
    id: z.string().regex(AUTHORIZATION_CHANGE_ID),
    legacyHead: z.string().regex(/^\d{4}_[a-z0-9_-]+$/),
    dependsOn: z.array(z.string().min(1)).min(1),
    definitions: z.array(definitionPatchSchema),
  })
  .strict();

export type AuthorizationChangeFile = AuthorizationSchemaChange & {
  readonly checksum: string;
};

export async function loadAuthorizationChangeFiles(folder: string): Promise<readonly AuthorizationChangeFile[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  const changes: AuthorizationChangeFile[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink())
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_INVALID",
        `authorization changes cannot contain symlinks: ${entry.name}`,
      );
    if (!entry.isDirectory()) continue;
    if (!AUTHORIZATION_CHANGE_ID.test(entry.name))
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_INVALID",
        `authorization change folder has invalid identity ${entry.name}`,
      );
    const entryFolder = join(folder, entry.name);
    const raw = await readFile(join(entryFolder, "patch.json"), "utf8");
    let content: unknown;
    try {
      content = JSON.parse(raw);
    } catch {
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_INVALID",
        `authorization change ${entry.name} has invalid JSON metadata`,
      );
    }
    const parsed = authorizationChangeSchema.safeParse(content);
    if (!parsed.success || parsed.data.id !== entry.name)
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_INVALID",
        `authorization change ${entry.name} has invalid patch metadata`,
      );
    await readFile(join(entryFolder, "migration.ts"), "utf8");
    changes.push({
      ...parsed.data,
      checksum: await authorizationChangeChecksum(entryFolder),
    });
  }
  return changes;
}

/** Metadata, hooks and entry-local supporting files are immutable applied content. */
async function authorizationChangeChecksum(folder: string): Promise<string> {
  const hash = createHash("sha256");
  const files = await entryFiles(folder);
  for (const file of files) {
    const contents = await readFile(join(folder, file));
    const canonicalFile = file.split(sep).join("/");
    hash
      .update(String(Buffer.byteLength(canonicalFile)))
      .update(":")
      .update(canonicalFile);
    hash.update(String(contents.byteLength)).update(":").update(contents);
  }
  return hash.digest("hex");
}

export async function authorizationLegacyJournalChecksum(folder: string): Promise<string> {
  const hash = createHash("sha256");
  const entries = (await readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{4}_/.test(entry.name))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries)
    hash
      .update(entry.name)
      .update(":")
      .update(await authorizationChangeChecksum(join(folder, entry.name)));
  return hash.digest("hex");
}

async function entryFiles(folder: string, prefix = ""): Promise<readonly string[]> {
  const entries = await readdir(join(folder, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const relative = join(prefix, entry.name);
    if (entry.isSymbolicLink())
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_INVALID",
        `authorization change supporting files cannot be symlinks: ${relative}`,
      );
    if (entry.isDirectory()) files.push(...(await entryFiles(folder, relative)));
    else if (entry.isFile()) files.push(relative);
    else
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_INVALID",
        `authorization change contains an unsupported file: ${relative}`,
      );
  }
  return files;
}
