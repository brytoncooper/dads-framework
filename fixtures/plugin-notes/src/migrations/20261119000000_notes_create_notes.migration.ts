import type { MigrationBuilder } from "node-pg-migrate";

/** The notes plugin's own table, journaled under the plugin's name. */
export function up(pgm: MigrationBuilder): void {
  pgm.createTable("notes", {
    id: { type: "text", primaryKey: true },
    text: { type: "text", notNull: true },
    written_at: { type: "timestamptz", notNull: true },
  });
}

export const down = false;
