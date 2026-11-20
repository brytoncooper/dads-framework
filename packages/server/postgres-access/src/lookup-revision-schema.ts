import { createHash } from "node:crypto";

const lookupRevisionSql = `
CREATE SCHEMA IF NOT EXISTS dad_lookup_revision;
REVOKE ALL ON SCHEMA dad_lookup_revision FROM PUBLIC;

CREATE SEQUENCE IF NOT EXISTS dad_lookup_revision.token;
CREATE TABLE IF NOT EXISTS dad_lookup_revision.epoch (
  singleton boolean PRIMARY KEY CHECK (singleton),
  installation uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 0
);
INSERT INTO dad_lookup_revision.epoch (singleton) VALUES (true)
  ON CONFLICT (singleton) DO UPDATE SET installation = excluded.installation;
CREATE TABLE IF NOT EXISTS dad_lookup_revision.namespace (
  namespace text PRIMARY KEY,
  revision bigint NOT NULL
);

CREATE OR REPLACE FUNCTION dad_lookup_revision.mark()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    UPDATE dad_lookup_revision.epoch
      SET revision = nextval('dad_lookup_revision.token') WHERE singleton;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO dad_lookup_revision.namespace
      SELECT touched.namespace, nextval('dad_lookup_revision.token')
      FROM (SELECT DISTINCT namespace FROM new_rows ORDER BY namespace) AS touched
      ON CONFLICT (namespace) DO UPDATE SET revision = excluded.revision;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO dad_lookup_revision.namespace
      SELECT touched.namespace, nextval('dad_lookup_revision.token')
      FROM (SELECT DISTINCT namespace FROM old_rows ORDER BY namespace) AS touched
      ON CONFLICT (namespace) DO UPDATE SET revision = excluded.revision;
  ELSE
    INSERT INTO dad_lookup_revision.namespace
      SELECT touched.namespace, nextval('dad_lookup_revision.token')
      FROM (SELECT namespace FROM new_rows UNION SELECT namespace FROM old_rows ORDER BY namespace) AS touched
      ON CONFLICT (namespace) DO UPDATE SET revision = excluded.revision;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION dad_lookup_revision.mark() FROM PUBLIC;

CREATE OR REPLACE TRIGGER dad_lookup_revision_insert
  AFTER INSERT ON public.dad_authorization_relationship
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION dad_lookup_revision.mark();
CREATE OR REPLACE TRIGGER dad_lookup_revision_delete
  AFTER DELETE ON public.dad_authorization_relationship
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION dad_lookup_revision.mark();
CREATE OR REPLACE TRIGGER dad_lookup_revision_update
  AFTER UPDATE ON public.dad_authorization_relationship
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION dad_lookup_revision.mark();
CREATE OR REPLACE TRIGGER dad_lookup_revision_truncate
  AFTER TRUNCATE ON public.dad_authorization_relationship
  FOR EACH STATEMENT EXECUTE FUNCTION dad_lookup_revision.mark();
ALTER TABLE public.dad_authorization_relationship ENABLE ALWAYS TRIGGER dad_lookup_revision_insert;
ALTER TABLE public.dad_authorization_relationship ENABLE ALWAYS TRIGGER dad_lookup_revision_delete;
ALTER TABLE public.dad_authorization_relationship ENABLE ALWAYS TRIGGER dad_lookup_revision_update;
ALTER TABLE public.dad_authorization_relationship ENABLE ALWAYS TRIGGER dad_lookup_revision_truncate;
`.trim();

/** Optional migration for immutable lookup results revalidated on a primary. */
export const lookupRevisionSchemaMigration = Object.freeze({
  adapter: "postgres-access",
  version: 2,
  id: "dad-authorization-lookup-revision-v2",
  checksum: createHash("sha256").update(lookupRevisionSql).digest("hex"),
  sql: lookupRevisionSql,
  advisoryLockSql: "SELECT pg_advisory_xact_lock(hashtext($1))",
});
