import type { CatalogColumn, CatalogEnum } from "./catalog-types.js";
import { snakeToCamel } from "./default-table-metadata.js";
import type { ColumnMetadata, PgEnumMetadata, TypeImportMetadata } from "./table-metadata.schema.js";

export type RenderedEnumUsage = {
  readonly schema: string;
  readonly name: string;
  readonly exportSymbol: string;
  readonly labels: readonly string[];
};

export type BaseBuilderResult = {
  readonly call: string;
  readonly basePgType: string;
  readonly pgCoreImports: readonly string[];
  readonly postgresImports: readonly string[];
  readonly customImports: readonly TypeImportMetadata[];
  readonly declaredEnum?: RenderedEnumUsage;
};

export type ColumnBuilderLookupContext = {
  readonly tableName: string;
  readonly column: CatalogColumn;
  readonly columnMetadata?: ColumnMetadata;
  readonly catalogEnums: readonly CatalogEnum[];
  readonly tableEnums: readonly PgEnumMetadata[];
};

const SIMPLE_PG_CORE_BUILDERS: Readonly<Record<string, string>> = {
  uuid: "uuid",
  text: "text",
  citext: "text",
  integer: "integer",
  int4: "integer",
  int: "integer",
  smallint: "smallint",
  int2: "smallint",
  real: "real",
  float4: "real",
  "double precision": "doublePrecision",
  float8: "doublePrecision",
  boolean: "boolean",
  bool: "boolean",
  jsonb: "jsonb",
  json: "json",
};

const POSTGRES_CUSTOM_BUILDERS: Readonly<Record<string, string>> = {
  bytea: "bytea",
  inet: "inet",
  xid8: "xid8",
};

/** Strips trailing array brackets and resolves the element UDT name and dimension count. */
export function unwrapArrayType(column: CatalogColumn): {
  readonly elementFormatted: string;
  readonly elementUdtName: string;
  readonly dimensions: number;
} {
  let elementFormatted = column.formattedType.trim();
  let bracketCount = 0;
  while (elementFormatted.endsWith("[]")) {
    elementFormatted = elementFormatted.slice(0, -2).trim();
    bracketCount += 1;
  }
  const dimensions = Math.max(column.arrayDimensions, bracketCount);
  const elementUdtName = dimensions > 0 && column.udtName.startsWith("_") ? column.udtName.slice(1) : column.udtName;
  return { elementFormatted, elementUdtName, dimensions };
}

function buildSizedCharBuilder(columnName: string, normalizedType: string): BaseBuilderResult | undefined {
  const varcharMatch = /^(?:character varying|varchar)(?:\((\d+)\))?$/i.exec(normalizedType);
  if (varcharMatch !== null) {
    const lengthArg = varcharMatch[1] !== undefined ? `, { length: ${varcharMatch[1]} }` : "";
    return {
      call: `varchar(${JSON.stringify(columnName)}${lengthArg})`,
      basePgType: "varchar",
      pgCoreImports: ["varchar"],
      postgresImports: [],
      customImports: [],
    };
  }
  const charMatch = /^(?:character|bpchar|char)(?:\((\d+)\))?$/i.exec(normalizedType);
  if (charMatch !== null) {
    const lengthArg = charMatch[1] !== undefined ? `, { length: ${charMatch[1]} }` : "";
    return {
      call: `char(${JSON.stringify(columnName)}${lengthArg})`,
      basePgType: "char",
      pgCoreImports: ["char"],
      postgresImports: [],
      customImports: [],
    };
  }
  return undefined;
}

function buildTimestampBuilder(
  columnName: string,
  withTimezone: boolean,
  precision: string | undefined,
  dateMode: "date" | "string" | undefined,
): BaseBuilderResult {
  const options: string[] = [`withTimezone: ${String(withTimezone)}`];
  if (precision !== undefined) options.push(`precision: ${precision}`);
  if (dateMode === "string") options.push(`mode: "string"`);
  return {
    call: `timestamp(${JSON.stringify(columnName)}, { ${options.join(", ")} })`,
    basePgType: withTimezone ? "timestamptz" : "timestamp",
    pgCoreImports: ["timestamp"],
    postgresImports: [],
    customImports: [],
  };
}

function buildTemporalBuilder(
  columnName: string,
  normalizedType: string,
  columnMetadata?: ColumnMetadata,
): BaseBuilderResult | undefined {
  if (normalizedType === "timestamptz") {
    return buildTimestampBuilder(columnName, true, undefined, columnMetadata?.dateMode);
  }
  const tsMatch = /^timestamp(?:\((\d+)\))?\s*(with time zone|without time zone)?$/i.exec(normalizedType);
  if (tsMatch !== null) {
    const withTimezone = tsMatch[2]?.toLowerCase() === "with time zone";
    return buildTimestampBuilder(columnName, withTimezone, tsMatch[1], columnMetadata?.dateMode);
  }
  if (normalizedType === "date") {
    const optionArg = columnMetadata?.dateMode === "date" ? `, { mode: "date" }` : "";
    return {
      call: `date(${JSON.stringify(columnName)}${optionArg})`,
      basePgType: "date",
      pgCoreImports: ["date"],
      postgresImports: [],
      customImports: [],
    };
  }
  return undefined;
}

function buildNumericOrTemporalBuilder(
  columnName: string,
  normalizedType: string,
  columnMetadata?: ColumnMetadata,
): BaseBuilderResult | undefined {
  if (normalizedType === "bigint" || normalizedType === "int8") {
    return {
      call: `bigint(${JSON.stringify(columnName)}, { mode: "number" })`,
      basePgType: "bigint",
      pgCoreImports: ["bigint"],
      postgresImports: [],
      customImports: [],
    };
  }
  const numericMatch = /^(?:numeric|decimal)(?:\((\d+)(?:,\s*(\d+))?\))?$/i.exec(normalizedType);
  if (numericMatch !== null) {
    const options: string[] = [];
    if (numericMatch[1] !== undefined) options.push(`precision: ${numericMatch[1]}`);
    if (numericMatch[2] !== undefined) options.push(`scale: ${numericMatch[2]}`);
    const optionArg = options.length > 0 ? `, { ${options.join(", ")} }` : "";
    return {
      call: `numeric(${JSON.stringify(columnName)}${optionArg})`,
      basePgType: "numeric",
      pgCoreImports: ["numeric"],
      postgresImports: [],
      customImports: [],
    };
  }
  return buildTemporalBuilder(columnName, normalizedType, columnMetadata);
}

function buildEnumBuilder(
  column: CatalogColumn,
  elementUdtName: string,
  context: ColumnBuilderLookupContext,
): BaseBuilderResult | undefined {
  const matchedEnum = context.catalogEnums.find(
    (entry) =>
      (entry.schema === column.udtSchema && entry.name === elementUdtName) ||
      entry.name === context.columnMetadata?.enumName,
  );
  if (context.columnMetadata?.enumImport !== undefined && context.columnMetadata.enumName !== undefined) {
    return {
      call: `${context.columnMetadata.enumName}(${JSON.stringify(column.name)})`,
      basePgType: "enum",
      pgCoreImports: [],
      postgresImports: [],
      customImports: [
        { from: context.columnMetadata.enumImport, names: [context.columnMetadata.enumName], typeOnly: false },
      ],
    };
  }
  if (matchedEnum === undefined) return undefined;
  const metaEnum = context.tableEnums.find((entry) => (entry.pgName ?? entry.name) === matchedEnum.name);
  const exportSymbol = metaEnum?.exportSymbol ?? `${snakeToCamel(matchedEnum.name)}Enum`;
  return {
    call: `${exportSymbol}(${JSON.stringify(column.name)})`,
    basePgType: "enum",
    pgCoreImports: [],
    postgresImports: [],
    customImports: [],
    declaredEnum: {
      schema: matchedEnum.schema,
      name: matchedEnum.name,
      exportSymbol,
      labels: matchedEnum.labels,
    },
  };
}

/** Maps a PostgreSQL element type to its Drizzle column builder call and required imports. */
export function resolveBaseColumnBuilder(
  context: ColumnBuilderLookupContext,
  elementFormatted: string,
  elementUdtName: string,
): BaseBuilderResult {
  const normalizedType = elementFormatted.toLowerCase();
  const enumBuilder = buildEnumBuilder(context.column, elementUdtName, context);
  if (enumBuilder !== undefined) return enumBuilder;

  const customName = POSTGRES_CUSTOM_BUILDERS[normalizedType] ?? POSTGRES_CUSTOM_BUILDERS[elementUdtName];
  if (customName !== undefined) {
    return {
      call: `${customName}(${JSON.stringify(context.column.name)})`,
      basePgType: customName,
      pgCoreImports: [],
      postgresImports: [customName],
      customImports: [],
    };
  }

  const simpleName = SIMPLE_PG_CORE_BUILDERS[normalizedType] ?? SIMPLE_PG_CORE_BUILDERS[elementUdtName];
  if (simpleName !== undefined) {
    return {
      call: `${simpleName}(${JSON.stringify(context.column.name)})`,
      basePgType: normalizedType,
      pgCoreImports: [simpleName],
      postgresImports: [],
      customImports: [],
    };
  }

  const charBuilder = buildSizedCharBuilder(context.column.name, normalizedType);
  if (charBuilder !== undefined) return charBuilder;

  const numTempBuilder = buildNumericOrTemporalBuilder(context.column.name, normalizedType, context.columnMetadata);
  if (numTempBuilder !== undefined) return numTempBuilder;

  throw new Error(
    `Unsupported PostgreSQL column type "${context.column.formattedType}" on ${context.tableName}.${context.column.name}`,
  );
}
