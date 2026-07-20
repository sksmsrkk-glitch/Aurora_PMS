BEGIN;

-- A retry cycle is separate from an individual attempt. This lets the reaper
-- reopen a DEAD delivery without colliding with the immutable attempt history,
-- while recovery_count places a hard ceiling on automated resurrection.
ALTER TABLE public.worker_jobs
  ADD COLUMN IF NOT EXISTS attempt_cycle integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS recovery_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_recovered_at timestamptz;

ALTER TABLE public.worker_jobs
  DROP CONSTRAINT IF EXISTS worker_job_attempt_cycle_check,
  DROP CONSTRAINT IF EXISTS worker_job_recovery_count_check;
ALTER TABLE public.worker_jobs
  ADD CONSTRAINT worker_job_attempt_cycle_check CHECK (attempt_cycle BETWEEN 1 AND 100),
  ADD CONSTRAINT worker_job_recovery_count_check CHECK (recovery_count BETWEEN 0 AND 99);

ALTER TABLE public.worker_attempts
  ADD COLUMN IF NOT EXISTS attempt_cycle integer NOT NULL DEFAULT 1;
ALTER TABLE public.worker_attempts
  DROP CONSTRAINT IF EXISTS worker_attempt_job_uq,
  DROP CONSTRAINT IF EXISTS worker_attempt_cycle_check,
  ADD CONSTRAINT worker_attempt_cycle_check CHECK (attempt_cycle BETWEEN 1 AND 100),
  ADD CONSTRAINT worker_attempt_job_cycle_uq UNIQUE(job_id,attempt_cycle,attempt_no);

-- Partial indexes keep both recovery scans bounded as the immutable attempt
-- ledger grows. The worker still locks candidates with SKIP LOCKED.
CREATE INDEX IF NOT EXISTS worker_job_stale_lock_idx
  ON public.worker_jobs(locked_at,id) WHERE status='RUNNING';
CREATE INDEX IF NOT EXISTS worker_job_dead_recovery_idx
  ON public.worker_jobs(completed_at,recovery_count,priority,created_at)
  WHERE status='DEAD' AND job_type IN ('OUTBOX_WEBHOOK','ARI_DELIVERY');

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607200017_worker_delivery_recovery')
ON CONFLICT(id) DO NOTHING;

COMMIT;
