import type { CatalogColumn, CatalogConstraint, CatalogEnum, ForeignKeyAction } from "./catalog-types.js";
import { snakeToCamel } from "./default-table-metadata.js";
import { resolveBaseColumnBuilder, unwrapArrayType, type RenderedEnumUsage } from "./render-column-builder.js";
import { escapeSqlTemplate, renderColumnDefault } from "./render-column-default.js";
import type { ColumnMetadata, PgEnumMetadata, TypeImportMetadata } from "./table-metadata.schema.js";

export type { RenderedEnumUsage } from "./render-column-builder.js";

export type ResolvedForeignKeyTarget = {
  readonly targetSymbol: string;
  readonly targetProperty: string;
  readonly isSelfReference: boolean;
  readonly onDelete: ForeignKeyAction | null;
  readonly onUpdate: ForeignKeyAction | null;
};

export type RenderColumnContext = {
  readonly tableName: string;
  readonly column: CatalogColumn;
  readonly columnMetadata?: ColumnMetadata;
  readonly isSinglePrimaryKey: boolean;
  readonly inlineForeignKey?: ResolvedForeignKeyTarget;
  readonly catalogEnums: readonly CatalogEnum[];
  readonly tableEnums: readonly PgEnumMetadata[];
};

export type RenderedColumn = {
  readonly columnName: string;
  readonly propertyName: string;
  readonly expression: string;
  readonly pgCoreImports: readonly string[];
  readonly pgCoreTypeImports: readonly string[];
  readonly postgresImports: readonly string[];
  readonly usesSql: boolean;
  readonly customImports: readonly TypeImportMetadata[];
  readonly declaredEnum?: RenderedEnumUsage;
};

const FK_ACTION_TO_DRIZZLE: Readonly<Record<ForeignKeyAction, string>> = {
  no_action: "no action",
  restrict: "restrict",
  cascade: "cascade",
  set_null: "set null",
  set_default: "set default",
};

function formatForeignKeyReference(fk: ResolvedForeignKeyTarget): string {
  const targetExpr = `${fk.targetSymbol}.${fk.targetProperty}`;
  const thunk = fk.isSelfReference ? `(): AnyPgColumn => ${targetExpr}` : `() => ${targetExpr}`;
  const options: string[] = [];
  if (fk.onDelete !== null && fk.onDelete !== "no_action") {
    options.push(`onDelete: ${JSON.stringify(FK_ACTION_TO_DRIZZLE[fk.onDelete])}`);
  }
  if (fk.onUpdate !== null && fk.onUpdate !== "no_action") {
    options.push(`onUpdate: ${JSON.stringify(FK_ACTION_TO_DRIZZLE[fk.onUpdate])}`);
  }
  const optionArg = options.length > 0 ? `, { ${options.join(", ")} }` : "";
  return `.references(${thunk}${optionArg})`;
}

function collectTypeChain(columnMetadata?: ColumnMetadata): {
  readonly chain: string;
  readonly imports: readonly TypeImportMetadata[];
} {
  if (columnMetadata?.brandType !== undefined) {
    return {
      chain: `.$type<${columnMetadata.brandType}>()`,
      imports:
        columnMetadata.brandImport !== undefined
          ? [{ from: columnMetadata.brandImport, names: [columnMetadata.brandType], typeOnly: true }]
          : [],
    };
  }
  if (columnMetadata?.jsonType !== undefined) {
    return {
      chain: `.$type<${columnMetadata.jsonType}>()`,
      imports:
        columnMetadata.jsonImport !== undefined
          ? [{ from: columnMetadata.jsonImport, names: [columnMetadata.jsonType], typeOnly: true }]
          : [],
    };
  }
  return { chain: "", imports: [] };
}

function appendIdentityOrDefault(
  column: CatalogColumn,
  basePgType: string,
): { readonly chain: string; readonly usesSql: boolean } {
  if (column.isIdentity) {
    return {
      chain: column.identityGeneration === "a" ? ".generatedAlwaysAsIdentity()" : ".generatedByDefaultAsIdentity()",
      usesSql: false,
    };
  }
  if (column.isGenerated && column.generatedExpression !== null) {
    return {
      chain: `.generatedAlwaysAs(sql\`${escapeSqlTemplate(column.generatedExpression)}\`)`,
      usesSql: true,
    };
  }
  return renderColumnDefault(column.defaultExpression, basePgType);
}

function formatColumnModifiers(
  context: RenderColumnContext,
  dimensions: number,
  defaultChain: string,
  typeChain: string,
): string {
  const parts: string[] = [];
  for (let dim = 0; dim < dimensions; dim += 1) parts.push(".array()");
  if (context.isSinglePrimaryKey) parts.push(".primaryKey()");
  if (defaultChain.length > 0) parts.push(defaultChain);
  if (!context.column.isNullable) parts.push(".notNull()");
  if (context.columnMetadata?.onUpdateNow === true) parts.push(".$onUpdate(() => new Date())");
  if (context.inlineForeignKey !== undefined) parts.push(formatForeignKeyReference(context.inlineForeignKey));
  if (typeChain.length > 0) parts.push(typeChain);
  return parts.join("");
}

/**
 * Renders one PostgreSQL catalog column into a Drizzle column property expression
 * together with every import and enum declaration it requires.
 */
export function renderTableColumn(context: RenderColumnContext): RenderedColumn {
  const { column, columnMetadata } = context;
  const { elementFormatted, elementUdtName, dimensions } = unwrapArrayType(column);
  const builder = resolveBaseColumnBuilder(context, elementFormatted, elementUdtName);
  const defaultPart = appendIdentityOrDefault(column, builder.basePgType);
  const typePart = collectTypeChain(columnMetadata);
  const modifiers = formatColumnModifiers(context, dimensions, defaultPart.chain, typePart.chain);
  const pgCoreTypeImports = context.inlineForeignKey?.isSelfReference === true ? ["AnyPgColumn"] : [];

  return {
    columnName: column.name,
    propertyName: columnMetadata?.propertyName ?? snakeToCamel(column.name),
    expression: `${builder.call}${modifiers}`,
    pgCoreImports: builder.pgCoreImports,
    pgCoreTypeImports,
    postgresImports: builder.postgresImports,
    usesSql: defaultPart.usesSql,
    customImports: [...builder.customImports, ...typePart.imports],
    ...(builder.declaredEnum === undefined ? {} : { declaredEnum: builder.declaredEnum }),
  };
}

/** Helper exported for `render-table-extras.ts` to format foreign key referential actions. */
export function drizzleForeignKeyAction(action: ForeignKeyAction): string {
  return FK_ACTION_TO_DRIZZLE[action];
}

/** Finds a single-column foreign key constraint for a given column name, if any. */
export function findSingleColumnForeignKey(
  constraints: readonly CatalogConstraint[],
  columnName: string,
): CatalogConstraint | undefined {
  return constraints.find(
    (constraint) =>
      constraint.kind === "foreign_key" &&
      constraint.columns.length === 1 &&
      constraint.columns[0] === columnName &&
      constraint.referencedColumns.length === 1,
  );
}
