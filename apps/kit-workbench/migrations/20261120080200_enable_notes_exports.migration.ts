import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    INSERT INTO feature_flag_states (id, slug, audience_mode, global_enabled_at, updated_by)
    VALUES (gen_random_uuid(), 'notes.export', 'EVERYONE', now(), 'starter-migration')
    ON CONFLICT (slug) DO NOTHING;
  `);
}

export const down = false;
