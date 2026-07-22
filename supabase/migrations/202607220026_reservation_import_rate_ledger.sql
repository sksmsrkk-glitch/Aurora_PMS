BEGIN;

-- Nightly rates remain immutable during normal PMS operation. A rollback may
-- delete them only when the same transaction names a completed reservation
-- import job that owns the reservation through data_import_entities.
CREATE OR REPLACE FUNCTION public.pms_booking_rate_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rollback_job text := NULLIF(current_setting('app.import_rollback_job_id',true),'');
BEGIN
  IF TG_OP='DELETE' AND rollback_job IS NOT NULL AND EXISTS(
    SELECT 1
      FROM public.data_import_jobs j
      JOIN public.data_import_entities e
        ON e.job_id=j.id AND e.property_id=j.property_id
     WHERE j.id=rollback_job
       AND j.property_id=OLD.property_id
       AND j.kind='RESERVATIONS'
       AND j.mode='COMMIT'
       AND j.status='COMPLETED'
       AND e.entity_type='RESERVATION'
       AND e.entity_id=OLD.reservation_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'reservation rate nights are immutable';
END;
$$;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607220026_reservation_import_rate_ledger')
ON CONFLICT (id) DO NOTHING;

COMMIT;
