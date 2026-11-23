import type { MigrationBuilder } from "node-pg-migrate";

import { up as installIdentitySchemaV1 } from "./migrations/20261120070500_identity.migration.js";
import { up as installIdentitySigningKeyMetadataSchema } from "./migrations/20261120070530_identity_jwks.migration.js";

/** Installs the default identity schema in a fresh database. */
export function installIdentitySchemaV2(pgm: MigrationBuilder): void {
  installIdentitySchemaV1(pgm);
  installIdentitySigningKeyMetadataSchema(pgm);
}
