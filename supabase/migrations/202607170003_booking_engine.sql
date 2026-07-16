BEGIN;

CREATE TABLE IF NOT EXISTS public.booking_requests (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  idempotency_key text NOT NULL,
  reservation_id text NOT NULL,
  email_hash text NOT NULL,
  created_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_request_idempotency_uq ON public.booking_requests(property_id,idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS booking_request_reservation_uq ON public.booking_requests(property_id,reservation_id);

CREATE TABLE IF NOT EXISTS public.reservation_rate_nights (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  reservation_id text NOT NULL,
  room_type_id text NOT NULL,
  stay_date text NOT NULL,
  sell_rate numeric(14,2) NOT NULL CHECK (sell_rate>=0),
  currency text NOT NULL,
  rate_plan text NOT NULL,
  created_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reservation_rate_night_uq ON public.reservation_rate_nights(reservation_id,stay_date);
CREATE INDEX IF NOT EXISTS reservation_rate_calendar_idx ON public.reservation_rate_nights(property_id,room_type_id,stay_date);
CREATE UNIQUE INDEX IF NOT EXISTS booking_requests_property_id_uq ON public.booking_requests(property_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS reservation_rate_nights_property_id_uq ON public.reservation_rate_nights(property_id,id);

ALTER TABLE public.booking_requests ADD CONSTRAINT booking_requests_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE RESTRICT;
ALTER TABLE public.booking_requests ADD CONSTRAINT booking_requests_reservation_fk FOREIGN KEY(property_id,reservation_id) REFERENCES public.reservations(property_id,id) ON DELETE RESTRICT;
ALTER TABLE public.reservation_rate_nights ADD CONSTRAINT reservation_rates_reservation_fk FOREIGN KEY(property_id,reservation_id) REFERENCES public.reservations(property_id,id) ON DELETE RESTRICT;
ALTER TABLE public.reservation_rate_nights ADD CONSTRAINT reservation_rates_type_fk FOREIGN KEY(property_id,room_type_id) REFERENCES public.room_types(property_id,id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public.pms_booking_rate_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'reservation rate nights are immutable'; END;
$$;
DROP TRIGGER IF EXISTS reservation_rate_nights_no_update ON public.reservation_rate_nights;
DROP TRIGGER IF EXISTS reservation_rate_nights_no_delete ON public.reservation_rate_nights;
CREATE TRIGGER reservation_rate_nights_no_update BEFORE UPDATE ON public.reservation_rate_nights FOR EACH ROW EXECUTE FUNCTION public.pms_booking_rate_immutable_guard();
CREATE TRIGGER reservation_rate_nights_no_delete BEFORE DELETE ON public.reservation_rate_nights FOR EACH ROW EXECUTE FUNCTION public.pms_booking_rate_immutable_guard();

ALTER TABLE public.booking_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservation_rate_nights ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.booking_requests FROM anon, authenticated;
REVOKE ALL ON TABLE public.reservation_rate_nights FROM anon, authenticated;

INSERT INTO public.pms_schema_migrations(id) VALUES ('202607170003_booking_engine') ON CONFLICT (id) DO NOTHING;
COMMIT;
