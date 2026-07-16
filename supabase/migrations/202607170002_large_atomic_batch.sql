BEGIN;
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
  -- 500 rooms plus audit and idempotency records fit in one transaction while
  -- retaining a strict payload ceiling against accidental unbounded batches.
  IF statement_count>600 THEN RAISE EXCEPTION 'too many PMS batch statements'; END IF;
  FOR statement_index IN 0..statement_count-1 LOOP
    statement := p_statements -> statement_index;
    batch_result := batch_result || jsonb_build_array(public.pms_execute_statement(statement->>'sql',COALESCE(statement->'values','[]'::jsonb)));
  END LOOP;
  RETURN batch_result;
END;
$$;
REVOKE ALL ON FUNCTION public.pms_batch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pms_batch(jsonb) TO service_role;
INSERT INTO public.pms_schema_migrations(id) VALUES ('202607170002_large_atomic_batch') ON CONFLICT (id) DO NOTHING;
NOTIFY pgrst, 'reload schema';
COMMIT;
