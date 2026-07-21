-- HotelStory-compatible voucher delivery queue with immutable document snapshots.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE public.reservation_voucher_deliveries (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  reservation_id text NOT NULL,
  language text NOT NULL,
  show_amount boolean NOT NULL DEFAULT true,
  recipient_email text NOT NULL,
  subject text NOT NULL,
  document_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED',
  provider_message_id text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  requested_by text NOT NULL,
  idempotency_key text NOT NULL,
  CONSTRAINT voucher_delivery_property_fk FOREIGN KEY(property_id)
    REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID,
  CONSTRAINT voucher_delivery_reservation_fk FOREIGN KEY(property_id,reservation_id)
    REFERENCES public.reservations(property_id,id) ON DELETE RESTRICT NOT VALID,
  CONSTRAINT voucher_delivery_language_check CHECK (language IN ('KO','EN')),
  CONSTRAINT voucher_delivery_email_check CHECK (recipient_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' AND char_length(recipient_email)<=254),
  CONSTRAINT voucher_delivery_subject_check CHECK (char_length(subject) BETWEEN 1 AND 200),
  CONSTRAINT voucher_delivery_payload_check CHECK (jsonb_typeof(document_payload)='object'),
  CONSTRAINT voucher_delivery_status_check CHECK (status IN ('QUEUED','SENDING','SENT','FAILED')),
  CONSTRAINT voucher_delivery_attempts_check CHECK (attempts>=0 AND attempts<=25),
  CONSTRAINT voucher_delivery_idempotency_uq UNIQUE(property_id,idempotency_key)
);
ALTER TABLE public.reservation_voucher_deliveries VALIDATE CONSTRAINT voucher_delivery_property_fk;
ALTER TABLE public.reservation_voucher_deliveries VALIDATE CONSTRAINT voucher_delivery_reservation_fk;
CREATE INDEX voucher_delivery_reservation_idx ON public.reservation_voucher_deliveries(property_id,reservation_id,queued_at DESC);
CREATE INDEX voucher_delivery_status_idx ON public.reservation_voucher_deliveries(property_id,status,queued_at) WHERE status IN ('QUEUED','SENDING','FAILED');

CREATE FUNCTION public.talos_voucher_delivery_immutable_fields()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.property_id IS DISTINCT FROM OLD.property_id
     OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
     OR NEW.language IS DISTINCT FROM OLD.language
     OR NEW.show_amount IS DISTINCT FROM OLD.show_amount
     OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email
     OR NEW.subject IS DISTINCT FROM OLD.subject
     OR NEW.document_payload IS DISTINCT FROM OLD.document_payload
     OR NEW.queued_at IS DISTINCT FROM OLD.queued_at
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'voucher delivery snapshot is immutable';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER voucher_delivery_immutable_update
BEFORE UPDATE ON public.reservation_voucher_deliveries
FOR EACH ROW EXECUTE FUNCTION public.talos_voucher_delivery_immutable_fields();

ALTER TABLE public.reservation_voucher_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservation_voucher_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY aurora_property_isolation ON public.reservation_voucher_deliveries
  FOR ALL TO aurora_app
  USING (property_id=public.pms_current_property_id())
  WITH CHECK (property_id=public.pms_current_property_id());
GRANT SELECT,INSERT,UPDATE ON TABLE public.reservation_voucher_deliveries TO aurora_app;
REVOKE ALL ON TABLE public.reservation_voucher_deliveries FROM anon,authenticated;

-- The generic durable queue now recognizes voucher email delivery. Provider-side
-- idempotency uses the delivery id so a successful send followed by a DB timeout
-- cannot create duplicate mail on retry.
ALTER TABLE public.worker_jobs DROP CONSTRAINT worker_job_type_check;
ALTER TABLE public.worker_jobs ADD CONSTRAINT worker_job_type_check
  CHECK (job_type IN ('OUTBOX_WEBHOOK','ARI_DELIVERY','BACKUP_VERIFY','DOMAIN_VERIFY','USAGE_ROLLUP','VOUCHER_EMAIL'));
DROP INDEX IF EXISTS public.worker_job_dead_recovery_idx;
CREATE INDEX worker_job_dead_recovery_idx
  ON public.worker_jobs(completed_at,recovery_count,priority,created_at)
  WHERE status='DEAD' AND job_type IN ('OUTBOX_WEBHOOK','ARI_DELIVERY','VOUCHER_EMAIL');

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607210022_reservation_voucher_delivery')
ON CONFLICT(id) DO NOTHING;

COMMIT;
