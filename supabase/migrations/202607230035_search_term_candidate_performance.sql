-- Token-first search candidates and compact per-token values for phone/ID lookup.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '300s';

CREATE OR REPLACE FUNCTION public.talos_refresh_search_terms(
  target_property_id text,
  target_entity_kind text,
  target_entity_id text
)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  DELETE FROM public.pms_search_terms
   WHERE property_id=target_property_id
     AND entity_kind=target_entity_kind
     AND entity_id=target_entity_id;

  INSERT INTO public.pms_search_terms(property_id,entity_kind,entity_id,term)
  SELECT DISTINCT
         document.property_id,
         document.entity_kind,
         document.entity_id,
         candidate.term
    FROM public.pms_search_documents document
    CROSS JOIN LATERAL (
      SELECT token term
        FROM regexp_split_to_table(document.search_text,'[[:space:]]+') token
      UNION
      SELECT public.talos_search_compact(token)
        FROM regexp_split_to_table(document.search_text,'[[:space:]]+') token
      UNION
      SELECT public.talos_search_romanize(token)
        FROM regexp_split_to_table(document.search_text,'[[:space:]]+') token
       WHERE token ~ '[가-힣]'
      UNION
      SELECT document.compact_text
      UNION
      SELECT document.initial_text
    ) candidate
   WHERE document.property_id=target_property_id
     AND document.entity_kind=target_entity_kind
     AND document.entity_id=target_entity_id
     AND char_length(candidate.term) BETWEEN 2 AND 120
  ON CONFLICT DO NOTHING;
END
$function$;

CREATE INDEX pms_search_terms_exact_lookup_idx
  ON public.pms_search_terms(property_id,entity_kind,term,entity_id);

SELECT public.talos_refresh_search_terms(property_id,entity_kind,entity_id)
  FROM public.pms_search_documents;

INSERT INTO public.audit_logs(
  id,property_id,actor,action,entity_type,entity_id,
  before_json,after_json,created_at
)
SELECT
  'migration-0035-search-candidates-'||md5(property_id),
  property_id,
  'system:migration',
  'SEARCH_TERM_CANDIDATE_BACKFILL',
  'pms_search_terms',
  property_id,
  NULL,
  jsonb_build_object('terms',count(*)),
  clock_timestamp()
FROM public.pms_search_terms
GROUP BY property_id
ON CONFLICT(id) DO NOTHING;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607230035_search_term_candidate_performance')
ON CONFLICT(id) DO NOTHING;

COMMIT;
