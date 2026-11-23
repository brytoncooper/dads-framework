import type { CatalogTable } from "./catalog-types.js";
import type { TableMetadata } from "./table-metadata.schema.js";

/** Converts a `snake_case` SQL identifier into `camelCase`. */
export function snakeToCamel(value: string): string {
  const parts = value.split("_").filter((part) => part.length > 0);
  if (parts.length === 0) return value;
  const [first, ...rest] = parts;
  if (first === undefined) return value;
  return (
    first.toLowerCase() + rest.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase()).join("")
  );
}

/** Converts a `snake_case` SQL identifier into `kebab-case`. */
export function snakeToKebab(value: string): string {
  return value
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase())
    .join("-");
}

/**
 * Infers default generator metadata for a catalog table so applications can
 * generate Drizzle modules without maintaining sidecar metadata files.
 */
export function inferDefaultTableMetadata(table: CatalogTable, outputDir?: string): TableMetadata {
  const fileName = `${snakeToKebab(table.name)}.tables.ts`;
  const trimmedDir = outputDir?.replace(/\/+$/, "");
  const outputFile = trimmedDir !== undefined && trimmedDir.length > 0 ? `${trimmedDir}/${fileName}` : fileName;

  return {
    owner: "app",
    schema: table.schema,
    table: table.name,
    outputFile,
    exportSymbol: snakeToCamel(table.name),
    columns: {},
  };
}
