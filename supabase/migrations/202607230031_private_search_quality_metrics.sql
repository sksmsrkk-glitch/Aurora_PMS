-- Privacy-preserving search quality metrics: no query, hash, user, or entity ID.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE public.pms_search_quality_daily (
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  event_date date NOT NULL,
  query_length_bucket smallint NOT NULL,
  query_script text NOT NULL,
  correction_used boolean NOT NULL,
  result_bucket text NOT NULL,
  latency_bucket text NOT NULL,
  searches bigint NOT NULL DEFAULT 0,
  zero_results bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pms_search_quality_length_bucket_check
    CHECK(query_length_bucket IN (2,4,8,16,32,64,120)),
  CONSTRAINT pms_search_quality_script_check
    CHECK(query_script IN ('HANGUL','LATIN','NUMERIC','MIXED','OTHER')),
  CONSTRAINT pms_search_quality_result_check
    CHECK(result_bucket IN ('ZERO','ONE','FEW','MANY','TRUNCATED')),
  CONSTRAINT pms_search_quality_latency_check
    CHECK(latency_bucket IN ('FAST','NORMAL','SLOW')),
  CONSTRAINT pms_search_quality_count_check
    CHECK(searches>0 AND zero_results BETWEEN 0 AND searches),
  CONSTRAINT pms_search_quality_daily_pk PRIMARY KEY(
    property_id,event_date,query_length_bucket,query_script,correction_used,
    result_bucket,latency_bucket
  )
);
CREATE INDEX pms_search_quality_recent_idx
  ON public.pms_search_quality_daily(property_id,event_date DESC);

ALTER TABLE public.pms_search_quality_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pms_search_quality_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY aurora_property_isolation ON public.pms_search_quality_daily
  FOR ALL TO aurora_app
  USING(property_id=public.pms_current_property_id())
  WITH CHECK(property_id=public.pms_current_property_id());
GRANT SELECT,INSERT,UPDATE ON TABLE public.pms_search_quality_daily TO aurora_app;
REVOKE ALL ON TABLE public.pms_search_quality_daily FROM anon,authenticated;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607230031_private_search_quality_metrics')
ON CONFLICT(id) DO NOTHING;

COMMIT;
