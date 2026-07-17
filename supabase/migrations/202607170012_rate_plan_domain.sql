-- First-class rate plans, room-type eligibility, and date-level rate calendars.
BEGIN;

CREATE TABLE public.rate_plans (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  currency text NOT NULL,
  market_segment text NOT NULL DEFAULT 'TRANSIENT',
  meal_plan text NOT NULL DEFAULT 'ROOM_ONLY',
  cancellation_policy text NOT NULL DEFAULT 'FLEXIBLE',
  guarantee_policy text NOT NULL DEFAULT 'CARD_GUARANTEE',
  pricing_model text NOT NULL DEFAULT 'FIXED',
  adjustment numeric NOT NULL DEFAULT 0,
  min_stay integer NOT NULL DEFAULT 1,
  max_stay integer NOT NULL DEFAULT 30,
  valid_from date,
  valid_to date,
  active integer NOT NULL DEFAULT 1,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT rate_plan_code_format CHECK (code ~ '^[A-Z0-9_-]{2,24}$'),
  CONSTRAINT rate_plan_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT rate_plan_pricing_model CHECK (pricing_model IN ('FIXED','OFFSET','PERCENT')),
  CONSTRAINT rate_plan_stay_bounds CHECK (min_stay BETWEEN 1 AND 365 AND max_stay BETWEEN min_stay AND 365),
  CONSTRAINT rate_plan_validity CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to>=valid_from),
  CONSTRAINT rate_plan_active_flag CHECK (active IN (0,1)),
  CONSTRAINT rate_plan_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE CASCADE,
  CONSTRAINT rate_plan_property_id_uq UNIQUE(property_id,id),
  CONSTRAINT rate_plan_property_code_uq UNIQUE(property_id,code)
);

CREATE TABLE public.rate_plan_room_types (
  property_id text NOT NULL,
  rate_plan_id text NOT NULL,
  room_type_id text NOT NULL,
  base_rate numeric NOT NULL,
  active integer NOT NULL DEFAULT 1,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL,
  updated_by text NOT NULL,
  PRIMARY KEY(property_id,rate_plan_id,room_type_id),
  CONSTRAINT rate_plan_room_base_rate CHECK (base_rate>=0),
  CONSTRAINT rate_plan_room_active_flag CHECK (active IN (0,1)),
  CONSTRAINT rate_plan_room_plan_fk FOREIGN KEY(property_id,rate_plan_id) REFERENCES public.rate_plans(property_id,id) ON DELETE CASCADE,
  CONSTRAINT rate_plan_room_type_fk FOREIGN KEY(property_id,room_type_id) REFERENCES public.room_types(property_id,id) ON DELETE CASCADE
);

CREATE TABLE public.rate_plan_calendar (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  rate_plan_id text NOT NULL,
  room_type_id text NOT NULL,
  stay_date date NOT NULL,
  sell_rate numeric NOT NULL,
  closed integer NOT NULL DEFAULT 0,
  min_stay integer NOT NULL DEFAULT 1,
  close_to_arrival integer NOT NULL DEFAULT 0,
  close_to_departure integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT rate_plan_calendar_rate CHECK (sell_rate>=0),
  CONSTRAINT rate_plan_calendar_min_stay CHECK (min_stay BETWEEN 1 AND 365),
  CONSTRAINT rate_plan_calendar_flags CHECK (closed IN (0,1) AND close_to_arrival IN (0,1) AND close_to_departure IN (0,1)),
  CONSTRAINT rate_plan_calendar_room_fk FOREIGN KEY(property_id,rate_plan_id,room_type_id) REFERENCES public.rate_plan_room_types(property_id,rate_plan_id,room_type_id) ON DELETE CASCADE,
  CONSTRAINT rate_plan_calendar_cell_uq UNIQUE(property_id,rate_plan_id,room_type_id,stay_date)
);

CREATE INDEX rate_plan_calendar_range_idx ON public.rate_plan_calendar(property_id,stay_date,room_type_id,rate_plan_id);
CREATE INDEX rate_plan_active_idx ON public.rate_plans(property_id,active,code);

-- Existing installations can contain free-form rate codes. Materialize every
-- referenced code before adding foreign keys so the migration is upgrade-safe.
WITH referenced_codes AS (
  SELECT property_id,rate_plan code FROM public.reservations
  UNION
  SELECT property_id,rate_plan code FROM public.reservation_rate_nights
  UNION
  SELECT property_id,rate_plan code FROM public.channel_mappings
)
INSERT INTO public.rate_plans(
  id,property_id,code,name,description,currency,created_at,updated_at,created_by,updated_by
)
SELECT
  'rp-'||substr(md5(property_id||':'||code),1,24),
  property_id,code,code,'업그레이드 중 기존 코드에서 생성된 요금제',
  COALESCE((SELECT currency FROM public.properties p WHERE p.id=referenced_codes.property_id),'KRW'),
  clock_timestamp(),clock_timestamp(),'system:migration','system:migration'
FROM referenced_codes
WHERE code IS NOT NULL AND code ~ '^[A-Z0-9_-]{2,24}$'
ON CONFLICT(property_id,code) DO NOTHING;

INSERT INTO public.rate_plan_room_types(property_id,rate_plan_id,room_type_id,base_rate,updated_at,updated_by)
SELECT rp.property_id,rp.id,rt.id,rt.base_rate,clock_timestamp(),'system:migration'
FROM public.rate_plans rp
JOIN public.room_types rt ON rt.property_id=rp.property_id
ON CONFLICT(property_id,rate_plan_id,room_type_id) DO NOTHING;

ALTER TABLE public.reservations
  ADD CONSTRAINT reservation_rate_plan_fk
  FOREIGN KEY(property_id,rate_plan) REFERENCES public.rate_plans(property_id,code) NOT VALID;
ALTER TABLE public.reservation_rate_nights
  ADD CONSTRAINT reservation_rate_night_plan_fk
  FOREIGN KEY(property_id,rate_plan) REFERENCES public.rate_plans(property_id,code) NOT VALID;
ALTER TABLE public.channel_mappings
  ADD CONSTRAINT channel_mapping_rate_plan_fk
  FOREIGN KEY(property_id,rate_plan) REFERENCES public.rate_plans(property_id,code) NOT VALID;
ALTER TABLE public.reservations VALIDATE CONSTRAINT reservation_rate_plan_fk;
ALTER TABLE public.reservation_rate_nights VALIDATE CONSTRAINT reservation_rate_night_plan_fk;
ALTER TABLE public.channel_mappings VALIDATE CONSTRAINT channel_mapping_rate_plan_fk;

DO $rate_plan_rls$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY['rate_plans','rate_plan_room_types','rate_plan_calendar'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tenant_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tenant_table);
    EXECUTE format(
      'CREATE POLICY aurora_property_isolation ON public.%I FOR ALL TO aurora_app USING (property_id=public.pms_current_property_id()) WITH CHECK (property_id=public.pms_current_property_id())',
      tenant_table
    );
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO aurora_app',tenant_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon,authenticated',tenant_table);
  END LOOP;
END
$rate_plan_rls$;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607170012_rate_plan_domain')
ON CONFLICT(id) DO NOTHING;

COMMIT;
