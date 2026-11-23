export type CatalogColumn = {
  readonly name: string;
  readonly ordinal: number;
  readonly formattedType: string;
  readonly udtSchema: string;
  readonly udtName: string;
  readonly isNullable: boolean;
  readonly defaultExpression: string | null;
  readonly isIdentity: boolean;
  readonly identityGeneration: "a" | "d" | null;
  readonly isGenerated: boolean;
  readonly generatedExpression: string | null;
  readonly arrayDimensions: number;
};

export type CatalogConstraintKind = "primary_key" | "foreign_key" | "unique" | "check";

export type ForeignKeyAction = "no_action" | "restrict" | "cascade" | "set_null" | "set_default";

export type CatalogConstraint = {
  readonly name: string;
  readonly kind: CatalogConstraintKind;
  readonly definition: string;
  readonly columns: readonly string[];
  readonly referencedSchema: string | null;
  readonly referencedTable: string | null;
  readonly referencedColumns: readonly string[];
  readonly onUpdate: ForeignKeyAction | null;
  readonly onDelete: ForeignKeyAction | null;
  readonly checkExpression: string | null;
};

export type CatalogIndex = {
  readonly name: string;
  readonly isUnique: boolean;
  readonly isPrimary: boolean;
  readonly accessMethod: string;
  readonly definition: string;
  readonly columns: readonly string[];
  readonly expressions: readonly string[];
  readonly wherePredicate: string | null;
};

export type CatalogTrigger = {
  readonly name: string;
  readonly definition: string;
  readonly isInternal: boolean;
};

export type CatalogEnum = {
  readonly schema: string;
  readonly name: string;
  readonly labels: readonly string[];
};

export type CatalogTable = {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly CatalogColumn[];
  readonly constraints: readonly CatalogConstraint[];
  readonly indexes: readonly CatalogIndex[];
  readonly triggers: readonly CatalogTrigger[];
};

export type CatalogSnapshot = {
  readonly schemas: readonly string[];
  readonly enums: readonly CatalogEnum[];
  readonly tables: readonly CatalogTable[];
};
