import type { RelationshipFilter } from "../runtime/authorization.js";

export type AuthorizationSchemaStore = {
  readSchema(): Promise<string>;
  writeSchema(schema: string): Promise<void>;
  deleteRelationships(filter: RelationshipFilter): Promise<unknown>;
};

export type SchemaRewriteStep = {
  name: string;
  apply: (store: AuthorizationSchemaStore) => Promise<void>;
};

/** Explicit copy-then-drop modules run before generic contraction. v1 is empty. */
export const SCHEMA_REWRITE_STEPS: readonly SchemaRewriteStep[] = [];
