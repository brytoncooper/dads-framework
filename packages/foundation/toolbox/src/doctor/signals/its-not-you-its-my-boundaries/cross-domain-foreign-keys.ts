/**
 * Opt-in strict-mode cross-domain SQL foreign keys: ceiling 0 when enabled.
 *
 * By default, SQL foreign keys between tables are permitted so teams can adopt
 * a single PostgreSQL database without extra ceremony. Repositories opting into
 * strict shard-ready domain isolation set `"strictForeignKeys": true` in
 * `dads.project.json`. When enabled, any domain migration under
 * `domains/<domain>/**` that declares a SQL `REFERENCES` (or node-pg-migrate
 * `references:` option) targeting a table owned by another domain is flagged,
 * directing the author to `@dads-framework/core/references`
 * (`declareCrossDomainReferences` + `checkCrossDomainReferences`).
 */

import { isRecord } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalEvidence, SignalReading, SignalReadings } from "../../doctor-signal.js";

const PROJECT_FILE = "dads.project.json";
const DOMAIN_MIGRATION_PATH = /^domains\/([^/]+)\/.*(?:\.migration\.ts|\.sql)$/;

const SQL_CREATE_TABLE =
  /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?)\s*\.\s*)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
const PGM_CREATE_TABLE_STRING =
  /\.createTable\s*\(\s*["'`](?:(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?)\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?["'`]/g;
const PGM_CREATE_TABLE_OBJECT = /\.createTable\s*\(\s*(\{[^}]*\})/g;

const SQL_REFERENCES = /\bREFERENCES\s+(?:(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?)\s*\.\s*)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
const PGM_REFERENCES_STRING =
  /\breferences\s*:\s*["'`](?:(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?)\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?(?:\s*\([^)]*\))?["'`]/g;
const PGM_REFERENCES_OBJECT = /\breferences\s*:\s*(\{[^}]*\})/g;

const OBJECT_SCHEMA_FIELD = /\bschema\s*:\s*["'`]([a-zA-Z_][a-zA-Z0-9_]*)["'`]/;
const OBJECT_NAME_FIELD = /\bname\s*:\s*["'`]([a-zA-Z_][a-zA-Z0-9_]*)["'`]/;

type DomainMigrationFile = {
  readonly domain: string;
  readonly path: string;
  readonly content: string;
};

type TableIdentifier = {
  readonly schema: string | undefined;
  readonly table: string;
};

type ForeignKeyReference = TableIdentifier & {
  readonly line: number;
};

function isStrictForeignKeysEnabled(context: DoctorContext): boolean {
  if (!context.exists(PROJECT_FILE)) return false;
  try {
    const parsed: unknown = JSON.parse(context.read(PROJECT_FILE));
    return isRecord(parsed) && parsed["strictForeignKeys"] === true;
  } catch {
    return false;
  }
}

function replaceWithSpacesKeepingNewlines(match: string): string {
  return match.replace(/[^\n]/g, " ");
}

function stripCommentsPreservingLines(content: string, isSqlFile: boolean): string {
  const withoutBlock = content.replace(/\/\*[\s\S]*?\*\//g, replaceWithSpacesKeepingNewlines);
  const withoutSqlComments = withoutBlock.replace(/--[^\n]*/g, replaceWithSpacesKeepingNewlines);
  if (isSqlFile) return withoutSqlComments;
  return withoutSqlComments.replace(/(^|[\s;])\/\/[^\n]*/gm, (match, prefix: string) => {
    return `${prefix}${replaceWithSpacesKeepingNewlines(match.slice(prefix.length))}`;
  });
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function parseObjectTableIdentifier(objectLiteral: string): TableIdentifier | undefined {
  const nameMatch = OBJECT_NAME_FIELD.exec(objectLiteral);
  const table = nameMatch?.[1];
  if (table === undefined) return undefined;
  const schemaMatch = OBJECT_SCHEMA_FIELD.exec(objectLiteral);
  return { schema: schemaMatch?.[1], table };
}

function collectPatternMatches(content: string, pattern: RegExp, onMatch: (match: RegExpExecArray) => void): void {
  const regex = new RegExp(pattern.source, pattern.flags);
  let match = regex.exec(content);
  while (match !== null) {
    onMatch(match);
    match = regex.exec(content);
  }
}

function extractCreatedTables(content: string): readonly TableIdentifier[] {
  const tables: TableIdentifier[] = [];
  const pushPair = (match: RegExpExecArray): void => {
    const table = match[2];
    if (table !== undefined) tables.push({ schema: match[1], table });
  };
  collectPatternMatches(content, SQL_CREATE_TABLE, pushPair);
  collectPatternMatches(content, PGM_CREATE_TABLE_STRING, pushPair);
  collectPatternMatches(content, PGM_CREATE_TABLE_OBJECT, (match) => {
    const objectLiteral = match[1];
    if (objectLiteral === undefined) return;
    const parsed = parseObjectTableIdentifier(objectLiteral);
    if (parsed !== undefined) tables.push(parsed);
  });
  return tables;
}

function extractForeignKeyReferences(content: string): readonly ForeignKeyReference[] {
  const references: ForeignKeyReference[] = [];
  const pushPair = (match: RegExpExecArray): void => {
    const table = match[2];
    if (table !== undefined) {
      references.push({ schema: match[1], table, line: lineNumberAt(content, match.index) });
    }
  };
  collectPatternMatches(content, SQL_REFERENCES, pushPair);
  collectPatternMatches(content, PGM_REFERENCES_STRING, pushPair);
  collectPatternMatches(content, PGM_REFERENCES_OBJECT, (match) => {
    const objectLiteral = match[1];
    if (objectLiteral === undefined) return;
    const parsed = parseObjectTableIdentifier(objectLiteral);
    if (parsed !== undefined) {
      references.push({ ...parsed, line: lineNumberAt(content, match.index) });
    }
  });
  return references;
}

function buildTableOwnerMap(files: readonly DomainMigrationFile[]): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  for (const file of files) {
    for (const entry of extractCreatedTables(file.content)) {
      const tableKey = entry.table.toLowerCase();
      owners.set(tableKey, file.domain);
      if (entry.schema !== undefined) {
        owners.set(`${entry.schema.toLowerCase()}.${tableKey}`, file.domain);
      }
    }
  }
  return owners;
}

function findOwner(owners: ReadonlyMap<string, string>, reference: TableIdentifier): string | undefined {
  const tableKey = reference.table.toLowerCase();
  if (reference.schema !== undefined) {
    const qualified = owners.get(`${reference.schema.toLowerCase()}.${tableKey}`);
    if (qualified !== undefined) return qualified;
  }
  return owners.get(tableKey);
}

function collectMigrationFiles(context: DoctorContext): readonly DomainMigrationFile[] {
  const files: DomainMigrationFile[] = [];
  for (const path of context.files()) {
    const match = DOMAIN_MIGRATION_PATH.exec(path);
    const domain = match?.[1];
    if (domain === undefined) continue;
    const raw = context.read(path);
    files.push({
      domain,
      path,
      content: stripCommentsPreservingLines(raw, path.endsWith(".sql")),
    });
  }
  return files;
}

function scanMigrationFile(file: DomainMigrationFile, owners: ReadonlyMap<string, string>): SignalReading {
  const evidence: SignalEvidence[] = [];
  for (const reference of extractForeignKeyReferences(file.content)) {
    const targetOwner = findOwner(owners, reference);
    if (targetOwner === undefined || targetOwner === file.domain) continue;
    const qualifiedTarget = reference.schema === undefined ? reference.table : `${reference.schema}.${reference.table}`;
    evidence.push({
      path: file.path,
      line: reference.line,
      name:
        `Cross-domain SQL foreign key from domain "${file.domain}" to "${qualifiedTarget}" ` +
        `(owned by domain "${targetOwner}") is disallowed in strict shard-ready mode. ` +
        `Use declareCrossDomainReferences and checkCrossDomainReferences from @dads-framework/core/references.`,
    });
  }
  return { value: evidence.length, evidence };
}

function countCrossDomainForeignKeys(context: DoctorContext): SignalReadings {
  if (!isStrictForeignKeysEnabled(context)) return new Map();
  const migrationFiles = collectMigrationFiles(context);
  const owners = buildTableOwnerMap(migrationFiles);
  const readings = new Map<string, SignalReading>();
  for (const file of migrationFiles) {
    readings.set(file.path, scanMigrationFile(file, owners));
  }
  return readings;
}

export const crossDomainForeignKeysSignal: DoctorSignal = {
  id: "cross-domain-foreign-keys",
  issue: "its-not-you-its-my-boundaries",
  question:
    "When `strictForeignKeys: true` is set in `dads.project.json`, does any domain migration declare a SQL foreign key referencing a table owned by a different domain?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "A domain that can move to its own database does not weld its foreign keys to a neighbor's tables.",
  run: (context) => Promise.resolve(countCrossDomainForeignKeys(context)),
};
