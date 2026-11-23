import { installEmailDeliverySchemaV1 } from "@dads-framework/email/delivery";
import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  installEmailDeliverySchemaV1(pgm);
}

export const down = false;
