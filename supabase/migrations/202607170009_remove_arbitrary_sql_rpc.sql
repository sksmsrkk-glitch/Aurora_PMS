-- Remove the legacy SQL-over-HTTP bridge. Even a server-only secret must never be
-- able to submit arbitrary SQL text through a SECURITY DEFINER function.
BEGIN;
REVOKE ALL ON FUNCTION public.pms_batch(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.pms_execute(text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.pms_execute_statement(text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.pms_render_sql(text,jsonb) FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.pms_batch(jsonb);
DROP FUNCTION IF EXISTS public.pms_execute(text,jsonb);
DROP FUNCTION IF EXISTS public.pms_execute_statement(text,jsonb);
DROP FUNCTION IF EXISTS public.pms_render_sql(text,jsonb);

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607170009_remove_arbitrary_sql_rpc')
ON CONFLICT (id) DO NOTHING;
COMMIT;
