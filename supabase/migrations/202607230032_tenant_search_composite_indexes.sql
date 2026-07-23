-- Keep fuzzy and partial search selective as each hotel grows to large data volumes.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '300s';

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA extensions;
DO $extension_schema$
DECLARE
  installed_schema text;
BEGIN
  SELECT namespace.nspname
    INTO installed_schema
    FROM pg_extension extension
    JOIN pg_namespace namespace ON namespace.oid=extension.extnamespace
   WHERE extension.extname='btree_gin';
  IF installed_schema IS DISTINCT FROM 'extensions' THEN
    ALTER EXTENSION btree_gin SET SCHEMA extensions;
  END IF;
END
$extension_schema$;
GRANT USAGE ON SCHEMA extensions TO aurora_app;

-- Equality opclasses from btree_gin and trigram opclasses from pg_trgm allow
-- one bitmap lookup to enforce tenant/domain scope and fuzzy text matching.
CREATE INDEX IF NOT EXISTS pms_search_documents_tenant_text_trgm_idx
  ON public.pms_search_documents USING gin(
    property_id extensions.text_ops,
    entity_kind extensions.text_ops,
    search_text extensions.gin_trgm_ops
  );
CREATE INDEX IF NOT EXISTS pms_search_documents_tenant_compact_trgm_idx
  ON public.pms_search_documents USING gin(
    property_id extensions.text_ops,
    entity_kind extensions.text_ops,
    compact_text extensions.gin_trgm_ops
  );
CREATE INDEX IF NOT EXISTS pms_search_documents_tenant_initial_trgm_idx
  ON public.pms_search_documents USING gin(
    property_id extensions.text_ops,
    entity_kind extensions.text_ops,
    initial_text extensions.gin_trgm_ops
  );
CREATE INDEX IF NOT EXISTS pms_search_terms_tenant_term_trgm_idx
  ON public.pms_search_terms USING gin(
    property_id extensions.text_ops,
    term extensions.gin_trgm_ops
  );

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607230032_tenant_search_composite_indexes')
ON CONFLICT(id) DO NOTHING;

COMMIT;
