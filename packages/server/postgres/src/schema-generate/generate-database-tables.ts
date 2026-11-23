import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { CatalogSnapshot, CatalogTable } from "./catalog-types.js";
import { inferDefaultTableMetadata, snakeToCamel } from "./default-table-metadata.js";
import {
  introspectPostgresCatalog,
  type CatalogQueryClient,
  type IntrospectPostgresCatalogOptions,
} from "./introspect-database.js";
import { normalizeCatalogSnapshot } from "./normalize-catalog.js";
import type { TableTargetLookup, TableTargetResolver } from "./render-table-extras.js";
import { renderTableModuleFile, type ModuleTableEntry } from "./render-table-module.js";
import { parseTableMetadata, type TableMetadata, type TableMetadataInput } from "./table-metadata.schema.js";
import { tableSchemaFingerprints, tableSchemaKey } from "./table-schema-fingerprint.js";

export type GeneratedTableSummary = {
  readonly schema: string;
  readonly table: string;
  readonly exportSymbol: string;
  readonly fingerprint: string;
};

export type GeneratedTableFile = {
  readonly outputFile: string;
  readonly content: string;
  readonly tables: readonly GeneratedTableSummary[];
};

export type GenerateDatabaseTableFilesInput = {
  readonly catalog: CatalogSnapshot;
  readonly metadata?: readonly TableMetadataInput[];
  readonly defaultOutputDir?: string;
  readonly retiredColumns?: Readonly<Record<string, readonly string[]>>;
};

export type TableDriftEntry = {
  readonly outputFile: string;
  readonly expectedFingerprints: readonly string[];
  readonly actualFingerprints: readonly string[];
};

export type TableDriftReport = {
  readonly ok: boolean;
  readonly drifted: readonly TableDriftEntry[];
  readonly missing: readonly string[];
};

export type IntrospectAndGenerateTablesOptions = IntrospectPostgresCatalogOptions & {
  readonly metadata?: readonly TableMetadataInput[];
  readonly defaultOutputDir?: string;
  readonly retiredColumns?: Readonly<Record<string, readonly string[]>>;
};

function indexMetadataByTable(
  metadataList: readonly TableMetadataInput[] | undefined,
): ReadonlyMap<string, TableMetadata> {
  const byKey = new Map<string, TableMetadata>();
  for (const raw of metadataList ?? []) {
    const parsed = parseTableMetadata(raw);
    const key = tableSchemaKey(parsed.schema, parsed.table);
    if (byKey.has(key)) {
      throw new Error(`Duplicate table metadata entry for ${key}`);
    }
    byKey.set(key, parsed);
  }
  return byKey;
}

function resolveRetiredColumns(
  table: CatalogTable,
  metadata: TableMetadata,
  retiredMap: Readonly<Record<string, readonly string[]>> | undefined,
): ReadonlySet<string> {
  const retired = new Set<string>(metadata.retiredColumns ?? []);
  const qualified = retiredMap?.[tableSchemaKey(table.schema, table.name)];
  const unqualified = retiredMap?.[table.name];
  for (const col of qualified ?? []) retired.add(col);
  for (const col of unqualified ?? []) retired.add(col);
  return retired;
}

function buildTargetResolver(entries: readonly ModuleTableEntry[]): TableTargetResolver {
  const lookup = new Map<string, TableTargetLookup>();
  for (const entry of entries) {
    const columnMap = new Map<string, string>();
    for (const column of entry.table.columns) {
      if (entry.retiredColumns.has(column.name)) continue;
      columnMap.set(column.name, entry.metadata.columns[column.name]?.propertyName ?? snakeToCamel(column.name));
    }
    lookup.set(tableSchemaKey(entry.table.schema, entry.table.name), {
      exportSymbol: entry.metadata.exportSymbol,
      outputFile: entry.metadata.outputFile,
      columnProperty: (columnName: string) => columnMap.get(columnName),
    });
  }
  return (schema: string, tableName: string) => lookup.get(tableSchemaKey(schema, tableName));
}

function groupEntriesByOutputFile(
  entries: readonly ModuleTableEntry[],
): ReadonlyMap<string, readonly ModuleTableEntry[]> {
  const grouped = new Map<string, ModuleTableEntry[]>();
  for (const entry of entries) {
    const existing = grouped.get(entry.metadata.outputFile);
    if (existing !== undefined) {
      existing.push(entry);
    } else {
      grouped.set(entry.metadata.outputFile, [entry]);
    }
  }
  return grouped;
}

/**
 * Generates deterministic Drizzle TypeScript module files for every table in a
 * PostgreSQL catalog snapshot. Uses explicit `metadata` where provided and
 * infers default metadata for any remaining tables.
 */
export function generateDatabaseTableFiles(input: GenerateDatabaseTableFilesInput): readonly GeneratedTableFile[] {
  const normalizedCatalog = normalizeCatalogSnapshot(input.catalog);
  const fingerprints = tableSchemaFingerprints(normalizedCatalog);
  const explicitMetadata = indexMetadataByTable(input.metadata);

  const entries: ModuleTableEntry[] = normalizedCatalog.tables.map((table) => {
    const key = tableSchemaKey(table.schema, table.name);
    const metadata = explicitMetadata.get(key) ?? inferDefaultTableMetadata(table, input.defaultOutputDir);
    const fingerprint = fingerprints.get(key);
    if (fingerprint === undefined) {
      throw new Error(`Missing schema fingerprint for table ${key}`);
    }
    return {
      table,
      metadata,
      fingerprint,
      retiredColumns: resolveRetiredColumns(table, metadata, input.retiredColumns),
    };
  });

  const resolveTarget = buildTargetResolver(entries);
  const grouped = groupEntriesByOutputFile(entries);
  const outputFiles = [...grouped.keys()].toSorted();

  return outputFiles.map((outputFile) => {
    const fileEntries = grouped.get(outputFile) ?? [];
    const content = renderTableModuleFile({
      outputFile,
      tables: fileEntries,
      catalogEnums: normalizedCatalog.enums,
      resolveTarget,
    });
    return {
      outputFile,
      content,
      tables: fileEntries.map((entry) => ({
        schema: entry.table.schema,
        table: entry.table.name,
        exportSymbol: entry.metadata.exportSymbol,
        fingerprint: entry.fingerprint,
      })),
    };
  });
}

function resolveContainedOutputPath(outputRoot: string, outputFile: string): string {
  const resolvedRoot = resolve(outputRoot);
  const targetPath = resolve(resolvedRoot, outputFile);
  const rel = relative(resolvedRoot, targetPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Generated outputFile "${outputFile}" escapes outputRoot "${outputRoot}"`);
  }
  return targetPath;
}

/** Writes every generated Drizzle module file under `outputRoot` and returns their paths. */
export async function writeGeneratedTableFiles(
  files: readonly GeneratedTableFile[],
  outputRoot: string,
): Promise<readonly string[]> {
  const written: string[] = [];
  for (const file of files) {
    const absolutePath = resolveContainedOutputPath(outputRoot, file.outputFile);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.content, "utf8");
    written.push(file.outputFile);
  }
  return written;
}

function extractFingerprintsFromSource(content: string): readonly string[] {
  const matches: string[] = [];
  const pattern = /^\/\/ Schema fingerprint (?:[a-zA-Z0-9_]+=)?([0-9a-f]{16}):/gm;
  let match = pattern.exec(content);
  while (match !== null) {
    if (match[1] !== undefined) matches.push(match[1]);
    match = pattern.exec(content);
  }
  return matches;
}

function isFileMissingError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Compares generated Drizzle table files against what is currently on disk
 * under `outputRoot` for CI drift detection.
 */
export async function checkGeneratedTableFiles(
  files: readonly GeneratedTableFile[],
  outputRoot: string,
): Promise<TableDriftReport> {
  const drifted: TableDriftEntry[] = [];
  const missing: string[] = [];

  for (const file of files) {
    const absolutePath = resolveContainedOutputPath(outputRoot, file.outputFile);
    let existing: string;
    try {
      existing = await readFile(absolutePath, "utf8");
    } catch (error: unknown) {
      if (isFileMissingError(error)) {
        missing.push(file.outputFile);
        continue;
      }
      throw error;
    }
    if (existing !== file.content) {
      drifted.push({
        outputFile: file.outputFile,
        expectedFingerprints: file.tables.map((table) => table.fingerprint),
        actualFingerprints: extractFingerprintsFromSource(existing),
      });
    }
  }

  return {
    ok: drifted.length === 0 && missing.length === 0,
    drifted,
    missing,
  };
}

function toIntrospectOptions(
  options: IntrospectAndGenerateTablesOptions | undefined,
): IntrospectPostgresCatalogOptions {
  if (options === undefined) return {};
  return {
    ...(options.schemas === undefined ? {} : { schemas: options.schemas }),
    ...(options.excludeTables === undefined ? {} : { excludeTables: options.excludeTables }),
  };
}

function toGenerateInput(
  catalog: CatalogSnapshot,
  options: IntrospectAndGenerateTablesOptions | undefined,
): GenerateDatabaseTableFilesInput {
  if (options === undefined) return { catalog };
  return {
    catalog,
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    ...(options.defaultOutputDir === undefined ? {} : { defaultOutputDir: options.defaultOutputDir }),
    ...(options.retiredColumns === undefined ? {} : { retiredColumns: options.retiredColumns }),
  };
}

/**
 * Introspects a live PostgreSQL database and renders its Drizzle table modules
 * in one step.
 */
export async function introspectAndGenerateTables(
  client: CatalogQueryClient,
  options?: IntrospectAndGenerateTablesOptions,
): Promise<readonly GeneratedTableFile[]> {
  const catalog = await introspectPostgresCatalog(client, toIntrospectOptions(options));
  return generateDatabaseTableFiles(toGenerateInput(catalog, options));
}
