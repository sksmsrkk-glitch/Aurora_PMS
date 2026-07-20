BEGIN;

-- Source retries are an explicit signal to revive a DEAD delivery. Reset its
-- retry budget and advance the immutable attempt cycle so attempt_no=1 can be
-- recorded again without colliding with the previous cycle. An in-flight job
-- keeps its lease unchanged: changing RUNNING to RETRY here would allow a
-- second worker to claim and deliver the same webhook concurrently.
CREATE OR REPLACE FUNCTION public.aurora_enqueue_outbox_job()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.status IN ('PENDING','FAILED') THEN
    INSERT INTO public.worker_jobs(id,property_id,job_type,source_id,payload,status,priority,available_at)
    VALUES ('job-outbox-'||NEW.id,NEW.property_id,'OUTBOX_WEBHOOK',NEW.id,
            jsonb_build_object('topic',NEW.topic,'aggregateType',NEW.aggregate_type,'aggregateId',NEW.aggregate_id),
            'PENDING',50,clock_timestamp())
    ON CONFLICT(property_id,job_type,source_id) DO UPDATE
      SET status=CASE
            WHEN public.worker_jobs.status IN ('RUNNING','SUCCEEDED') THEN public.worker_jobs.status
            ELSE 'RETRY'
          END,
          attempts=CASE WHEN public.worker_jobs.status='DEAD' THEN 0 ELSE public.worker_jobs.attempts END,
          attempt_cycle=CASE WHEN public.worker_jobs.status='DEAD' THEN public.worker_jobs.attempt_cycle+1 ELSE public.worker_jobs.attempt_cycle END,
          available_at=CASE WHEN public.worker_jobs.status IN ('RUNNING','SUCCEEDED') THEN public.worker_jobs.available_at ELSE clock_timestamp() END,
          completed_at=CASE WHEN public.worker_jobs.status='DEAD' THEN NULL ELSE public.worker_jobs.completed_at END,
          locked_at=CASE WHEN public.worker_jobs.status='DEAD' THEN NULL ELSE public.worker_jobs.locked_at END,
          locked_by=CASE WHEN public.worker_jobs.status='DEAD' THEN NULL ELSE public.worker_jobs.locked_by END,
          last_error=CASE WHEN public.worker_jobs.status='DEAD' THEN NULL ELSE public.worker_jobs.last_error END,
          updated_at=clock_timestamp();
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.aurora_enqueue_ari_job()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.status IN ('PENDING','FAILED') THEN
    INSERT INTO public.worker_jobs(id,property_id,job_type,source_id,payload,status,priority,available_at)
    VALUES ('job-ari-'||NEW.id,NEW.property_id,'ARI_DELIVERY',NEW.id,
            jsonb_build_object('connectionId',NEW.connection_id,'mappingId',NEW.mapping_id,'stayDate',NEW.stay_date,'revision',NEW.revision),
            'PENDING',25,clock_timestamp())
    ON CONFLICT(property_id,job_type,source_id) DO UPDATE
      SET status=CASE
            WHEN public.worker_jobs.status IN ('RUNNING','SUCCEEDED') THEN public.worker_jobs.status
            ELSE 'RETRY'
          END,
          attempts=CASE WHEN public.worker_jobs.status='DEAD' THEN 0 ELSE public.worker_jobs.attempts END,
          attempt_cycle=CASE WHEN public.worker_jobs.status='DEAD' THEN public.worker_jobs.attempt_cycle+1 ELSE public.worker_jobs.attempt_cycle END,
          available_at=CASE WHEN public.worker_jobs.status IN ('RUNNING','SUCCEEDED') THEN public.worker_jobs.available_at ELSE clock_timestamp() END,
          completed_at=CASE WHEN public.worker_jobs.status='DEAD' THEN NULL ELSE public.worker_jobs.completed_at END,
          locked_at=CASE WHEN public.worker_jobs.status='DEAD' THEN NULL ELSE public.worker_jobs.locked_at END,
          locked_by=CASE WHEN public.worker_jobs.status='DEAD' THEN NULL ELSE public.worker_jobs.locked_by END,
          last_error=CASE WHEN public.worker_jobs.status='DEAD' THEN NULL ELSE public.worker_jobs.last_error END,
          updated_at=clock_timestamp();
  END IF;
  RETURN NEW;
END
$function$;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607200019_worker_enqueue_revival_guards')
ON CONFLICT(id) DO NOTHING;

COMMIT;
