export type {
  CatalogColumn,
  CatalogConstraint,
  CatalogConstraintKind,
  CatalogEnum,
  CatalogIndex,
  CatalogSnapshot,
  CatalogTable,
  CatalogTrigger,
  ForeignKeyAction,
} from "./catalog-types.js";
export { inferDefaultTableMetadata, snakeToCamel, snakeToKebab } from "./default-table-metadata.js";
export {
  checkGeneratedTableFiles,
  generateDatabaseTableFiles,
  introspectAndGenerateTables,
  writeGeneratedTableFiles,
  type GenerateDatabaseTableFilesInput,
  type GeneratedTableFile,
  type GeneratedTableSummary,
  type IntrospectAndGenerateTablesOptions,
  type TableDriftEntry,
  type TableDriftReport,
} from "./generate-database-tables.js";
export {
  introspectPostgresCatalog,
  type CatalogQueryClient,
  type IntrospectPostgresCatalogOptions,
} from "./introspect-database.js";
export { normalizeCatalogSnapshot } from "./normalize-catalog.js";
export {
  renderTableColumn,
  type RenderColumnContext,
  type RenderedColumn,
  type RenderedEnumUsage,
  type ResolvedForeignKeyTarget,
} from "./render-column.js";
export { renderTableModuleFile, type ModuleTableEntry, type RenderTableModuleInput } from "./render-table-module.js";
export {
  columnMetadataSchema,
  parseTableMetadata,
  pgEnumMetadataSchema,
  relationEntryMetadataSchema,
  relationMetadataSchema,
  tableMetadataSchema,
  typeImportMetadataSchema,
  type ColumnMetadata,
  type PgEnumMetadata,
  type RelationEntryMetadata,
  type RelationMetadata,
  type TableMetadata,
  type TableMetadataInput,
  type TypeImportMetadata,
} from "./table-metadata.schema.js";
export { computeTableSchemaFingerprint, tableSchemaFingerprints, tableSchemaKey } from "./table-schema-fingerprint.js";
