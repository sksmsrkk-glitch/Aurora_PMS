BEGIN;

-- Migration 0016 enqueue triggers can turn a previously DEAD source back into
-- RETRY without lowering attempts. Such a row is intentionally unclaimable
-- (attempts=max_attempts), so index it with DEAD rows for bounded cycle reset.
DROP INDEX IF EXISTS public.worker_job_dead_recovery_idx;
CREATE INDEX worker_job_dead_recovery_idx
  ON public.worker_jobs(
    COALESCE(completed_at,updated_at),recovery_count,priority,created_at
  )
  WHERE job_type IN ('OUTBOX_WEBHOOK','ARI_DELIVERY')
    AND (status='DEAD' OR (status='RETRY' AND attempts>=max_attempts));

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607200018_exhausted_worker_retry_recovery')
ON CONFLICT(id) DO NOTHING;

COMMIT;
