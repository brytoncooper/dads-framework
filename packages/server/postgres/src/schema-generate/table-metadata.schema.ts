import { z } from "zod";

export const columnMetadataSchema = z.strictObject({
  propertyName: z.string().min(1).optional(),
  brandType: z.string().min(1).optional(),
  brandImport: z.string().min(1).optional(),
  jsonType: z.string().min(1).optional(),
  jsonImport: z.string().min(1).optional(),
  enumName: z.string().min(1).optional(),
  enumImport: z.string().min(1).optional(),
  onUpdateNow: z.boolean().optional(),
  dateMode: z.enum(["date", "string"]).optional(),
});

export const typeImportMetadataSchema = z.strictObject({
  from: z.string().min(1),
  names: z.array(z.string().min(1)).min(1),
  typeOnly: z.boolean().optional(),
});

export const pgEnumMetadataSchema = z.strictObject({
  name: z.string().min(1),
  exportSymbol: z.string().min(1),
  pgName: z.string().min(1).optional(),
  schema: z.string().min(1).optional(),
});

export const relationEntryMetadataSchema = z.strictObject({
  propertyName: z.string().min(1),
  kind: z.enum(["one", "many"]),
  targetSymbol: z.string().min(1),
  targetImport: z.string().min(1).optional(),
  fields: z.array(z.string().min(1)).optional(),
  references: z.array(z.string().min(1)).optional(),
  relationName: z.string().min(1).optional(),
});

export const relationMetadataSchema = z.strictObject({
  exportSymbol: z.string().min(1),
  entries: z.array(relationEntryMetadataSchema).min(1),
});

export const tableMetadataSchema = z.strictObject({
  owner: z.string().min(1),
  schema: z.string().min(1).default("public"),
  table: z.string().min(1),
  outputFile: z.string().min(1),
  exportSymbol: z.string().min(1),
  documentation: z.string().optional(),
  columns: z.record(z.string(), columnMetadataSchema).default({}),
  typeImports: z.array(typeImportMetadataSchema).optional(),
  pgEnums: z.array(pgEnumMetadataSchema).optional(),
  relations: z.array(relationMetadataSchema).optional(),
  retiredColumns: z.array(z.string().min(1)).optional(),
});

export type ColumnMetadata = z.output<typeof columnMetadataSchema>;
export type TypeImportMetadata = z.output<typeof typeImportMetadataSchema>;
export type PgEnumMetadata = z.output<typeof pgEnumMetadataSchema>;
export type RelationEntryMetadata = z.output<typeof relationEntryMetadataSchema>;
export type RelationMetadata = z.output<typeof relationMetadataSchema>;
export type TableMetadata = z.output<typeof tableMetadataSchema>;
export type TableMetadataInput = z.input<typeof tableMetadataSchema>;

/** Validates and normalizes an external table metadata entry at the boundary. */
export function parseTableMetadata(input: unknown): TableMetadata {
  return tableMetadataSchema.parse(input);
}
