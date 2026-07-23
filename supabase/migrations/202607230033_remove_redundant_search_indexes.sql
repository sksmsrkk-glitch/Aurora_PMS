-- Remove superseded single-column GIN indexes to cap search-write amplification.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

DROP INDEX IF EXISTS public.pms_search_document_text_trgm_idx;
DROP INDEX IF EXISTS public.pms_search_document_compact_trgm_idx;
DROP INDEX IF EXISTS public.pms_search_document_initial_trgm_idx;
DROP INDEX IF EXISTS public.pms_search_term_trgm_idx;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607230033_remove_redundant_search_indexes')
ON CONFLICT(id) DO NOTHING;

COMMIT;
