-- Replace SQLite-era textual dates with PostgreSQL temporal types.
-- Every ALTER is transactional: an invalid legacy value aborts the migration
-- instead of silently coercing or truncating operational history.
BEGIN;

DO $native_dates$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT table_schema, table_name, column_name
      FROM information_schema.columns
     WHERE table_schema='public'
       AND data_type='text'
       AND column_name LIKE '%\_date' ESCAPE '\'
     ORDER BY table_name, ordinal_position
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I TYPE date USING NULLIF(%I, '''')::date',
      item.table_schema, item.table_name, item.column_name, item.column_name
    );
  END LOOP;
END
$native_dates$;

DO $native_timestamps$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT table_schema, table_name, column_name
      FROM information_schema.columns
     WHERE table_schema='public'
       AND data_type='text'
       AND (column_name LIKE '%\_at' ESCAPE '\' OR column_name='window_start')
     ORDER BY table_name, ordinal_position
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I TYPE timestamptz USING NULLIF(%I, '''')::timestamptz',
      item.table_schema, item.table_name, item.column_name, item.column_name
    );
  END LOOP;
END
$native_timestamps$;

DO $native_times$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT table_schema, table_name, column_name
      FROM information_schema.columns
     WHERE table_schema='public'
       AND data_type='text'
       AND column_name IN ('eta','checkin_time','checkout_time')
     ORDER BY table_name, ordinal_position
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I DROP DEFAULT',
      item.table_schema, item.table_name, item.column_name
    );
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I TYPE time USING NULLIF(%I, '''')::time',
      item.table_schema, item.table_name, item.column_name, item.column_name
    );
  END LOOP;
END
$native_times$;

ALTER TABLE public.website_settings
  ALTER COLUMN checkin_time SET DEFAULT TIME '15:00',
  ALTER COLUMN checkout_time SET DEFAULT TIME '11:00';

-- NEW.stay_date is now a date. An exact overload prevents implicit text casts
-- from weakening trigger function resolution under concurrent inventory writes.
CREATE OR REPLACE FUNCTION public.pms_lock_inventory(
  p_property text,
  p_room_type text,
  p_stay_date date
)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_property || ':' || p_room_type || ':' || p_stay_date::text, 0)
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.pms_block_pickup_apply()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='INSERT' THEN
    UPDATE public.block_inventory
       SET picked_up=picked_up+1,
           version=version+1,
           updated_at=NEW.created_at
     WHERE block_id=NEW.block_id
       AND room_type_id=NEW.room_type_id
       AND stay_date=NEW.stay_date;
    RETURN NEW;
  END IF;
  UPDATE public.block_inventory
     SET picked_up=GREATEST(0,picked_up-1),
         version=version+1,
         updated_at=clock_timestamp()
   WHERE block_id=OLD.block_id
     AND room_type_id=OLD.room_type_id
     AND stay_date=OLD.stay_date;
  RETURN OLD;
END
$function$;

DROP FUNCTION IF EXISTS public.pms_lock_inventory(text,text,text);

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607170011_native_temporal_types')
ON CONFLICT (id) DO NOTHING;

COMMIT;
