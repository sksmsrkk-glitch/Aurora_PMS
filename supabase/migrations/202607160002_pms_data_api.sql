-- Historical server-only PostgreSQL bridge for the Talos PMS Worker.
BEGIN;

CREATE OR REPLACE FUNCTION public.pms_render_sql(p_sql text, p_values jsonb DEFAULT '[]'::jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  rendered text := btrim(p_sql);
  bind_count integer := COALESCE(jsonb_array_length(p_values),0);
  bind_index integer;
  marker text;
BEGIN
  IF rendered='' OR rendered LIKE '%;%' OR rendered !~* '^(SELECT|WITH|INSERT|UPDATE|DELETE)[[:space:]]' THEN
    RAISE EXCEPTION 'unsupported PMS statement';
  END IF;
  IF bind_count>100 THEN RAISE EXCEPTION 'too many PMS statement parameters'; END IF;

  FOR bind_index IN REVERSE bind_count..1 LOOP
    marker := '__aurora_pms_bind_' || bind_index || '__';
    rendered := replace(rendered, '$' || bind_index, marker);
  END LOOP;
  FOR bind_index IN 1..bind_count LOOP
    marker := '__aurora_pms_bind_' || bind_index || '__';
    rendered := replace(rendered, marker, quote_nullable(p_values ->> (bind_index-1)));
  END LOOP;
  IF rendered ~ '\$[0-9]+' THEN RAISE EXCEPTION 'unbound PMS statement parameter'; END IF;
  RETURN rendered;
END;
$$;

CREATE OR REPLACE FUNCTION public.pms_execute_statement(p_sql text, p_values jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rendered text := public.pms_render_sql(p_sql,p_values);
  row_data jsonb := '[]'::jsonb;
  changed integer := 0;
BEGIN
  IF rendered ~* '^(SELECT|WITH)[[:space:]]' THEN
    EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(pms_rows)),''[]''::jsonb) FROM (%s) pms_rows',rendered) INTO row_data;
    changed := COALESCE(jsonb_array_length(row_data),0);
  ELSE
    EXECUTE rendered;
    GET DIAGNOSTICS changed = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('results',row_data,'changes',changed);
END;
$$;

CREATE OR REPLACE FUNCTION public.pms_execute(p_sql text, p_values jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT public.pms_execute_statement(p_sql,p_values) $$;

CREATE OR REPLACE FUNCTION public.pms_batch(p_statements jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  statement_count integer := COALESCE(jsonb_array_length(p_statements),0);
  statement_index integer;
  statement jsonb;
  batch_result jsonb := '[]'::jsonb;
BEGIN
  IF statement_count>500 THEN RAISE EXCEPTION 'too many PMS batch statements'; END IF;
  FOR statement_index IN 0..statement_count-1 LOOP
    statement := p_statements -> statement_index;
    batch_result := batch_result || jsonb_build_array(public.pms_execute_statement(statement->>'sql',COALESCE(statement->'values','[]'::jsonb)));
  END LOOP;
  RETURN batch_result;
END;
$$;

REVOKE ALL ON FUNCTION public.pms_render_sql(text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pms_execute_statement(text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pms_execute(text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pms_batch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pms_execute(text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.pms_batch(jsonb) TO service_role;

INSERT INTO pms_schema_migrations(id) VALUES ('202607160002_pms_data_api') ON CONFLICT (id) DO NOTHING;
NOTIFY pgrst, 'reload schema';
COMMIT;
