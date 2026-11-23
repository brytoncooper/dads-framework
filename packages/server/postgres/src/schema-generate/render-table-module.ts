import { posix } from "node:path";
import type { CatalogEnum, CatalogTable } from "./catalog-types.js";
import { snakeToCamel } from "./default-table-metadata.js";
import {
  findSingleColumnForeignKey,
  renderTableColumn,
  type RenderedColumn,
  type RenderedEnumUsage,
  type ResolvedForeignKeyTarget,
} from "./render-column.js";
import {
  renderTableExtras,
  renderTableRelations,
  type TableTargetLookup,
  type TableTargetResolver,
} from "./render-table-extras.js";
import type { TableMetadata, TypeImportMetadata } from "./table-metadata.schema.js";

export type ModuleTableEntry = {
  readonly table: CatalogTable;
  readonly metadata: TableMetadata;
  readonly fingerprint: string;
  readonly retiredColumns: ReadonlySet<string>;
};

export type RenderTableModuleInput = {
  readonly outputFile: string;
  readonly tables: readonly ModuleTableEntry[];
  readonly catalogEnums: readonly CatalogEnum[];
  readonly resolveTarget: TableTargetResolver;
};

type ImportAccumulator = {
  readonly drizzleValues: Set<string>;
  readonly pgCoreValues: Set<string>;
  readonly pgCoreTypes: Set<string>;
  readonly postgresValues: Set<string>;
  readonly valueImports: Map<string, Set<string>>;
  readonly typeImports: Map<string, Set<string>>;
};

function createImportAccumulator(): ImportAccumulator {
  return {
    drizzleValues: new Set<string>(),
    pgCoreValues: new Set<string>(),
    pgCoreTypes: new Set<string>(),
    postgresValues: new Set<string>(),
    valueImports: new Map<string, Set<string>>(),
    typeImports: new Map<string, Set<string>>(),
  };
}

function addImportSpec(target: Map<string, Set<string>>, specifier: string, name: string): void {
  const existing = target.get(specifier);
  if (existing !== undefined) {
    existing.add(name);
    return;
  }
  target.set(specifier, new Set([name]));
}

function addCustomImports(acc: ImportAccumulator, imports: readonly TypeImportMetadata[]): void {
  for (const item of imports) {
    const bucket = item.typeOnly === false ? acc.valueImports : acc.typeImports;
    for (const name of item.names) {
      addImportSpec(bucket, item.from, name);
    }
  }
}

function relativeModuleImport(fromFile: string, toFile: string): string {
  const fromDir = posix.dirname(fromFile);
  let rel = posix.relative(fromDir, toFile);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel.replace(/\.ts$/, ".js");
}

function addCrossFileTargetImport(acc: ImportAccumulator, currentOutputFile: string, target: TableTargetLookup): void {
  if (target.outputFile === currentOutputFile) return;
  addImportSpec(acc.valueImports, relativeModuleImport(currentOutputFile, target.outputFile), target.exportSymbol);
}

function resolveInlineFk(
  entry: ModuleTableEntry,
  columnName: string,
  resolveTarget: TableTargetResolver,
): { readonly inlineFk?: ResolvedForeignKeyTarget; readonly target?: TableTargetLookup } {
  const fk = findSingleColumnForeignKey(entry.table.constraints, columnName);
  if (fk === undefined || fk.referencedSchema === null || fk.referencedTable === null) return {};
  const targetCol = fk.referencedColumns[0];
  if (targetCol === undefined) return {};
  const target = resolveTarget(fk.referencedSchema, fk.referencedTable);
  if (target === undefined) return {};
  const targetProperty = target.columnProperty(targetCol);
  if (targetProperty === undefined) return {};
  const isSelfReference = fk.referencedSchema === entry.table.schema && fk.referencedTable === entry.table.name;
  return {
    target,
    inlineFk: {
      targetSymbol: target.exportSymbol,
      targetProperty,
      isSelfReference,
      onDelete: fk.onDelete,
      onUpdate: fk.onUpdate,
    },
  };
}

function findSinglePrimaryKeyColumn(table: CatalogTable): string | undefined {
  const pk = table.constraints.find((constraint) => constraint.kind === "primary_key");
  if (pk === undefined || pk.columns.length !== 1) return undefined;
  return pk.columns[0];
}

function formatDocumentationComment(doc: string | undefined): string {
  if (doc === undefined || doc.trim().length === 0) return "";
  const lines = doc
    .trim()
    .split("\n")
    .map((line) => (line.length > 0 ? ` * ${line}` : " *"));
  return `/**\n${lines.join("\n")}\n */\n`;
}

function schemaVariableName(schema: string): string {
  return `${snakeToCamel(schema)}Schema`;
}

function renderSingleTableDeclaration(
  entry: ModuleTableEntry,
  outputFile: string,
  catalogEnums: readonly CatalogEnum[],
  resolveTarget: TableTargetResolver,
  acc: ImportAccumulator,
  declaredEnums: Map<string, RenderedEnumUsage>,
  customSchemas: Set<string>,
): { readonly tableCode: string; readonly relationBlocks: readonly string[] } {
  const singlePkColumn = findSinglePrimaryKeyColumn(entry.table);
  const renderedColumns: RenderedColumn[] = [];
  const columnMap = new Map<string, string>();

  for (const column of entry.table.columns) {
    if (entry.retiredColumns.has(column.name)) continue;
    const fkLookup = resolveInlineFk(entry, column.name, resolveTarget);
    if (fkLookup.target !== undefined) addCrossFileTargetImport(acc, outputFile, fkLookup.target);
    const columnMetadata = entry.metadata.columns[column.name];
    const rendered = renderTableColumn({
      tableName: entry.table.name,
      column,
      isSinglePrimaryKey: singlePkColumn === column.name,
      catalogEnums,
      tableEnums: entry.metadata.pgEnums ?? [],
      ...(columnMetadata === undefined ? {} : { columnMetadata }),
      ...(fkLookup.inlineFk === undefined ? {} : { inlineForeignKey: fkLookup.inlineFk }),
    });
    renderedColumns.push(rendered);
    columnMap.set(column.name, rendered.propertyName);
    collectColumnImports(acc, rendered, declaredEnums);
  }

  return assembleTableDeclaration(entry, outputFile, renderedColumns, columnMap, resolveTarget, acc, customSchemas);
}

function collectColumnImports(
  acc: ImportAccumulator,
  rendered: RenderedColumn,
  declaredEnums: Map<string, RenderedEnumUsage>,
): void {
  for (const name of rendered.pgCoreImports) acc.pgCoreValues.add(name);
  for (const name of rendered.pgCoreTypeImports) acc.pgCoreTypes.add(name);
  for (const name of rendered.postgresImports) acc.postgresValues.add(name);
  if (rendered.usesSql) acc.drizzleValues.add("sql");
  addCustomImports(acc, rendered.customImports);
  if (rendered.declaredEnum !== undefined) {
    declaredEnums.set(`${rendered.declaredEnum.schema}.${rendered.declaredEnum.name}`, rendered.declaredEnum);
  }
}

function assembleTableDeclaration(
  entry: ModuleTableEntry,
  outputFile: string,
  renderedColumns: readonly RenderedColumn[],
  columnMap: ReadonlyMap<string, string>,
  resolveTarget: TableTargetResolver,
  acc: ImportAccumulator,
  customSchemas: Set<string>,
): { readonly tableCode: string; readonly relationBlocks: readonly string[] } {
  const extras = renderTableExtras(entry.table, columnMap, entry.retiredColumns, resolveTarget);
  for (const name of extras.pgCoreImports) acc.pgCoreValues.add(name);
  if (extras.usesSql) acc.drizzleValues.add("sql");
  for (const target of extras.referencedTables) addCrossFileTargetImport(acc, outputFile, target);

  const relations = renderTableRelations(entry.metadata.exportSymbol, entry.metadata.relations);
  if (relations.usesRelations) acc.drizzleValues.add("relations");
  addCustomImports(acc, relations.customImports);
  if (entry.metadata.typeImports !== undefined) addCustomImports(acc, entry.metadata.typeImports);

  const tableFactory = entry.table.schema === "public" ? "pgTable" : `${schemaVariableName(entry.table.schema)}.table`;
  if (entry.table.schema === "public") {
    acc.pgCoreValues.add("pgTable");
  } else {
    acc.pgCoreValues.add("pgSchema");
    customSchemas.add(entry.table.schema);
  }

  const colLines = renderedColumns.map((col) => `    ${col.propertyName}: ${col.expression},`).join("\n");
  const extrasArg =
    extras.entries.length > 0
      ? `,\n  (table) => [\n${extras.entries.map((item) => `    ${item},`).join("\n")}\n  ]`
      : "";
  const doc = formatDocumentationComment(entry.metadata.documentation);
  const tableCode =
    `${doc}export const ${entry.metadata.exportSymbol} = ${tableFactory}(\n` +
    `  ${JSON.stringify(entry.table.name)},\n` +
    `  {\n${colLines}\n  }${extrasArg},\n` +
    `);`;
  return { tableCode, relationBlocks: relations.blocks };
}

function collectExplicitEnums(
  tables: readonly ModuleTableEntry[],
  catalogEnums: readonly CatalogEnum[],
  declaredEnums: Map<string, RenderedEnumUsage>,
): void {
  for (const entry of tables) {
    for (const metaEnum of entry.metadata.pgEnums ?? []) {
      const targetSchema = metaEnum.schema ?? entry.table.schema;
      const pgName = metaEnum.pgName ?? metaEnum.name;
      const found = catalogEnums.find((item) => item.schema === targetSchema && item.name === pgName);
      if (found === undefined) continue;
      declaredEnums.set(`${found.schema}.${found.name}`, {
        schema: found.schema,
        name: found.name,
        exportSymbol: metaEnum.exportSymbol,
        labels: found.labels,
      });
    }
  }
}

function formatImportBlock(acc: ImportAccumulator): string {
  const lines: string[] = [];
  if (acc.drizzleValues.size > 0) {
    lines.push(`import { ${[...acc.drizzleValues].toSorted().join(", ")} } from "drizzle-orm";`);
  }
  const pgCoreSpecs = [
    ...[...acc.pgCoreValues].toSorted(),
    ...[...acc.pgCoreTypes].toSorted().map((name) => `type ${name}`),
  ];
  if (pgCoreSpecs.length > 0) {
    lines.push(`import { ${pgCoreSpecs.join(", ")} } from "drizzle-orm/pg-core";`);
  }
  if (acc.postgresValues.size > 0) {
    lines.push(`import { ${[...acc.postgresValues].toSorted().join(", ")} } from "@dads-framework/postgres";`);
  }
  for (const specifier of [...acc.valueImports.keys()].toSorted()) {
    const names = [...(acc.valueImports.get(specifier) ?? [])].toSorted();
    lines.push(`import { ${names.join(", ")} } from ${JSON.stringify(specifier)};`);
  }
  for (const specifier of [...acc.typeImports.keys()].toSorted()) {
    const names = [...(acc.typeImports.get(specifier) ?? [])].toSorted();
    lines.push(`import type { ${names.join(", ")} } from ${JSON.stringify(specifier)};`);
  }
  return lines.join("\n");
}

function formatHeaderLines(tables: readonly ModuleTableEntry[]): string {
  const headerLines = ["// GENERATED - DO NOT EDIT. Author a migration, then regenerate Drizzle tables."];
  if (tables.length === 1 && tables[0] !== undefined) {
    headerLines.push(`// Schema fingerprint ${tables[0].fingerprint}: columns, constraints, indexes, triggers.`);
  } else {
    for (const entry of tables) {
      headerLines.push(
        `// Schema fingerprint ${entry.table.name}=${entry.fingerprint}: columns, constraints, indexes, triggers.`,
      );
    }
  }
  return headerLines.join("\n");
}

function formatEnumDeclarations(
  declaredEnums: ReadonlyMap<string, RenderedEnumUsage>,
  acc: ImportAccumulator,
  customSchemas: Set<string>,
): readonly string[] {
  const declarations: string[] = [];
  for (const key of [...declaredEnums.keys()].toSorted()) {
    const item = declaredEnums.get(key);
    if (item === undefined) continue;
    const labels = `[${item.labels.map((label) => JSON.stringify(label)).join(", ")}]`;
    if (item.schema === "public") {
      acc.pgCoreValues.add("pgEnum");
      declarations.push(`export const ${item.exportSymbol} = pgEnum(${JSON.stringify(item.name)}, ${labels});`);
    } else {
      acc.pgCoreValues.add("pgSchema");
      customSchemas.add(item.schema);
      declarations.push(
        `export const ${item.exportSymbol} = ${schemaVariableName(item.schema)}.enum(${JSON.stringify(item.name)}, ${labels});`,
      );
    }
  }
  return declarations;
}

/** Renders one generated Drizzle TypeScript module file from one or more catalog tables. */
export function renderTableModuleFile(input: RenderTableModuleInput): string {
  const acc = createImportAccumulator();
  const declaredEnums = new Map<string, RenderedEnumUsage>();
  const customSchemas = new Set<string>();
  const tableBlocks: string[] = [];
  const relationBlocks: string[] = [];

  collectExplicitEnums(input.tables, input.catalogEnums, declaredEnums);

  for (const entry of input.tables) {
    const rendered = renderSingleTableDeclaration(
      entry,
      input.outputFile,
      input.catalogEnums,
      input.resolveTarget,
      acc,
      declaredEnums,
      customSchemas,
    );
    tableBlocks.push(rendered.tableCode);
    relationBlocks.push(...rendered.relationBlocks);
  }

  const enumBlocks = formatEnumDeclarations(declaredEnums, acc, customSchemas);
  const schemaBlocks = [...customSchemas]
    .toSorted()
    .map((schema) => `const ${schemaVariableName(schema)} = pgSchema(${JSON.stringify(schema)});`);

  const sections = [
    formatHeaderLines(input.tables),
    formatImportBlock(acc),
    ...schemaBlocks,
    ...enumBlocks,
    ...tableBlocks,
    ...relationBlocks,
  ].filter((section) => section.length > 0);

  return `${sections.join("\n\n")}\n`;
}
