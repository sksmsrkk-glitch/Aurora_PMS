-- Native booleans/JSONB and enforceable reservation invariants.
BEGIN;

-- Integer flag checks must be removed before their columns become booleans.
ALTER TABLE public.accounting_accounts DROP CONSTRAINT IF EXISTS accounting_accounts_active_check;
ALTER TABLE public.inventory_controls DROP CONSTRAINT IF EXISTS inventory_controls_website_closed_check;
ALTER TABLE public.rate_plan_calendar DROP CONSTRAINT IF EXISTS rate_plan_calendar_flags;
ALTER TABLE public.rate_plan_room_types DROP CONSTRAINT IF EXISTS rate_plan_room_active_flag;
ALTER TABLE public.rate_plans DROP CONSTRAINT IF EXISTS rate_plan_active_flag;
ALTER TABLE public.room_type_website DROP CONSTRAINT IF EXISTS room_type_website_published_check;
ALTER TABLE public.website_media DROP CONSTRAINT IF EXISTS website_media_active_check;
ALTER TABLE public.website_settings DROP CONSTRAINT IF EXISTS website_settings_published_check;

DO $native_flags$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('account_profiles','active',true),
      ('accounting_accounts','active',true),
      ('ari_updates','close_to_arrival',false),
      ('ari_updates','close_to_departure',false),
      ('ari_updates','closed',false),
      ('business_blocks','deduct_inventory',true),
      ('channel_mappings','active',true),
      ('folio_routing_rules','active',true),
      ('inventory_controls','close_to_arrival',false),
      ('inventory_controls','close_to_departure',false),
      ('inventory_controls','closed',false),
      ('inventory_controls','website_closed',false),
      ('rate_plan_calendar','close_to_arrival',false),
      ('rate_plan_calendar','close_to_departure',false),
      ('rate_plan_calendar','closed',false),
      ('rate_plan_room_types','active',true),
      ('rate_plans','active',true),
      ('role_assignments','active',true),
      ('room_type_website','published',false),
      ('room_types','active',true),
      ('rooms','active',true),
      ('transaction_codes','active',true),
      ('website_media','active',true),
      ('website_settings','published',true)
    ) AS flags(table_name,column_name,default_value)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP DEFAULT',item.table_name,item.column_name);
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN %I TYPE boolean USING (%I=1)',
      item.table_name,item.column_name,item.column_name
    );
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT %L::boolean',
      item.table_name,item.column_name,item.default_value
    );
  END LOOP;
END
$native_flags$;

DO $native_json$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('ari_updates','payload_json'),
      ('audit_logs','after_json'),
      ('audit_logs','before_json'),
      ('guests','preferences'),
      ('inbound_channel_messages','payload_json'),
      ('integration_delivery_attempts','payload_json'),
      ('night_audits','blockers_json'),
      ('night_audits','summary_json'),
      ('outbox_events','payload_json'),
      ('report_exports','filters_json'),
      ('room_type_website','amenities_json'),
      ('rooms','features')
    ) AS payloads(table_name,column_name)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP DEFAULT',item.table_name,item.column_name);
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN %I TYPE jsonb USING CASE WHEN %I IS NULL THEN NULL ELSE %I::jsonb END',
      item.table_name,item.column_name,item.column_name,item.column_name
    );
  END LOOP;
END
$native_json$;

ALTER TABLE public.rooms ALTER COLUMN features SET DEFAULT '[]'::jsonb;
ALTER TABLE public.guests ALTER COLUMN preferences SET DEFAULT '[]'::jsonb;
ALTER TABLE public.room_type_website ALTER COLUMN amenities_json SET DEFAULT '[]'::jsonb;
ALTER TABLE public.rooms ADD CONSTRAINT rooms_features_array CHECK (jsonb_typeof(features)='array');
ALTER TABLE public.guests ADD CONSTRAINT guests_preferences_array CHECK (jsonb_typeof(preferences)='array');
ALTER TABLE public.room_type_website ADD CONSTRAINT room_type_amenities_array CHECK (jsonb_typeof(amenities_json)='array');
ALTER TABLE public.ari_updates ADD CONSTRAINT ari_payload_object CHECK (jsonb_typeof(payload_json)='object');
ALTER TABLE public.inbound_channel_messages ADD CONSTRAINT inbound_payload_object CHECK (jsonb_typeof(payload_json)='object');
ALTER TABLE public.integration_delivery_attempts ADD CONSTRAINT delivery_payload_object CHECK (jsonb_typeof(payload_json)='object');
ALTER TABLE public.outbox_events ADD CONSTRAINT outbox_payload_object CHECK (jsonb_typeof(payload_json)='object');
ALTER TABLE public.report_exports ADD CONSTRAINT report_filters_object CHECK (jsonb_typeof(filters_json)='object');
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_before_object CHECK (before_json IS NULL OR jsonb_typeof(before_json)='object');
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_after_object CHECK (after_json IS NULL OR jsonb_typeof(after_json)='object');
ALTER TABLE public.night_audits ADD CONSTRAINT night_audit_blockers_array CHECK (jsonb_typeof(blockers_json)='array');
ALTER TABLE public.night_audits ADD CONSTRAINT night_audit_summary_object CHECK (summary_json IS NULL OR jsonb_typeof(summary_json)='object');

-- Historical QA created same-day checked-out reservations before a stay-range
-- invariant existed. Preserve their financial history, record the repair, and
-- normalize them to one night before validating the new constraint.
INSERT INTO public.audit_logs(
  id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at
)
SELECT
  'migration-013-stay-'||r.id,r.property_id,'system:migration',
  'NORMALIZE_ZERO_NIGHT_RESERVATION','reservation',r.id,
  jsonb_build_object('arrivalDate',r.arrival_date,'departureDate',r.departure_date),
  jsonb_build_object('arrivalDate',r.arrival_date,'departureDate',r.arrival_date+1),
  clock_timestamp()
FROM public.reservations r
WHERE r.departure_date<=r.arrival_date
ON CONFLICT(id) DO NOTHING;

UPDATE public.reservations
SET departure_date=arrival_date+1,version=version+1,updated_at=clock_timestamp()
WHERE departure_date<=arrival_date;

ALTER TABLE public.reservations
  ADD CONSTRAINT reservations_stay_range_check CHECK (departure_date>arrival_date) NOT VALID,
  ADD CONSTRAINT reservations_occupancy_check CHECK (adults BETWEEN 1 AND 20 AND children BETWEEN 0 AND 20) NOT VALID,
  ADD CONSTRAINT reservations_nightly_rate_check CHECK (nightly_rate>=0) NOT VALID,
  ADD CONSTRAINT reservations_version_check CHECK (version>=1) NOT VALID,
  ADD CONSTRAINT reservations_status_check CHECK (status IN ('DUE_IN','IN_HOUSE','CHECKED_OUT','NO_SHOW','CANCELLED')) NOT VALID;
ALTER TABLE public.reservations VALIDATE CONSTRAINT reservations_stay_range_check;
ALTER TABLE public.reservations VALIDATE CONSTRAINT reservations_occupancy_check;
ALTER TABLE public.reservations VALIDATE CONSTRAINT reservations_nightly_rate_check;
ALTER TABLE public.reservations VALIDATE CONSTRAINT reservations_version_check;
ALTER TABLE public.reservations VALIDATE CONSTRAINT reservations_status_check;

-- Trigger bodies are replaced in the same transaction so no statement can
-- observe native boolean columns through legacy integer comparisons.
CREATE OR REPLACE FUNCTION public.pms_reservation_capacity_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  capacity_limit integer;
  sold integer;
  held integer;
  is_closed boolean;
BEGIN
  PERFORM public.pms_lock_inventory(NEW.property_id,NEW.room_type_id,NEW.stay_date);
  SELECT COALESCE(ic.closed,false),COALESCE(ic.sell_limit,
    (SELECT COUNT(*) FROM public.rooms r WHERE r.property_id=NEW.property_id AND r.room_type_id=NEW.room_type_id AND r.active AND r.housekeeping_status<>'OUT_OF_SERVICE'))
  INTO is_closed,capacity_limit
  FROM (SELECT 1) seed LEFT JOIN public.inventory_controls ic
    ON ic.property_id=NEW.property_id AND ic.room_type_id=NEW.room_type_id AND ic.stay_date=NEW.stay_date;
  IF is_closed THEN RAISE EXCEPTION 'room type closed'; END IF;
  SELECT COUNT(*) INTO sold FROM public.reservation_type_nights
    WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date;
  SELECT COALESCE(SUM(bi.current_rooms-bi.picked_up),0) INTO held
    FROM public.block_inventory bi JOIN public.business_blocks bb ON bb.id=bi.block_id
    WHERE bi.property_id=NEW.property_id AND bi.room_type_id=NEW.room_type_id AND bi.stay_date=NEW.stay_date
      AND bb.deduct_inventory AND bb.status IN ('TENTATIVE','DEFINITE');
  IF sold+held>=capacity_limit THEN RAISE EXCEPTION 'room type sold out'; END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.pms_block_inventory_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  capacity_limit integer;
  sold integer;
  held integer;
  deducts boolean;
BEGIN
  IF NEW.original_rooms<0 OR NEW.current_rooms<0 OR NEW.picked_up<0 OR NEW.current_rooms<NEW.picked_up OR NEW.rate<0 THEN
    RAISE EXCEPTION 'invalid block inventory';
  END IF;
  SELECT deduct_inventory INTO deducts FROM public.business_blocks WHERE id=NEW.block_id;
  IF COALESCE(deducts,false) THEN
    PERFORM public.pms_lock_inventory(NEW.property_id,NEW.room_type_id,NEW.stay_date);
    SELECT COALESCE(ic.sell_limit,
      (SELECT COUNT(*) FROM public.rooms r WHERE r.property_id=NEW.property_id AND r.room_type_id=NEW.room_type_id AND r.active AND r.housekeeping_status<>'OUT_OF_SERVICE'))
    INTO capacity_limit
    FROM (SELECT 1) seed LEFT JOIN public.inventory_controls ic
      ON ic.property_id=NEW.property_id AND ic.room_type_id=NEW.room_type_id AND ic.stay_date=NEW.stay_date;
    SELECT COUNT(*) INTO sold FROM public.reservation_type_nights
      WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date;
    SELECT COALESCE(SUM(bi.current_rooms-bi.picked_up),0) INTO held
      FROM public.block_inventory bi JOIN public.business_blocks bb ON bb.id=bi.block_id
      WHERE bi.property_id=NEW.property_id AND bi.room_type_id=NEW.room_type_id AND bi.stay_date=NEW.stay_date
        AND (TG_OP='INSERT' OR bi.id<>OLD.id) AND bb.deduct_inventory AND bb.status IN ('TENTATIVE','DEFINITE');
    IF sold+held+(NEW.current_rooms-NEW.picked_up)>capacity_limit THEN RAISE EXCEPTION 'block inventory sold out'; END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.pms_accounting_line_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.accounting_accounts a
    WHERE a.id=NEW.account_id AND a.property_id=NEW.property_id AND a.active
  ) THEN RAISE EXCEPTION 'active accounting account is required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.accounting_journal_entries e
    WHERE e.id=NEW.journal_entry_id AND e.property_id=NEW.property_id AND e.status='POSTED'
  ) THEN RAISE EXCEPTION 'posted journal entry is required'; END IF;
  RETURN NEW;
END
$function$;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607170013_native_flags_json_constraints')
ON CONFLICT(id) DO NOTHING;

COMMIT;
