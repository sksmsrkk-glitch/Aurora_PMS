-- Shared fixed-window counters replace process-local Maps, which reset on every
-- serverless cold start and cannot coordinate concurrent Vercel instances.
BEGIN;
CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  scope text NOT NULL,
  key_hash text NOT NULL,
  window_start text NOT NULL,
  count integer NOT NULL DEFAULT 1 CHECK(count>0),
  expires_at text NOT NULL,
  PRIMARY KEY(scope,key_hash,window_start)
);
CREATE INDEX IF NOT EXISTS api_rate_limits_expiry_idx ON public.api_rate_limits(expires_at);
ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.api_rate_limits FROM anon, authenticated;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607170008_distributed_rate_limits')
ON CONFLICT (id) DO NOTHING;
COMMIT;
