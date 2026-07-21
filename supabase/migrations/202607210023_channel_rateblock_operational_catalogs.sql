-- HotelStory-compatible channel catalog, product/channel rate blocks, and hotel catalogs.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE public.channel_catalog (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  provider_code text NOT NULL,
  display_name text NOT NULL,
  channel_class text NOT NULL DEFAULT 'OTA',
  integration_mode text NOT NULL DEFAULT 'INTEGRATED',
  description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  CONSTRAINT channel_catalog_property_fk FOREIGN KEY(property_id)
    REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID,
  CONSTRAINT channel_catalog_class_check CHECK (channel_class IN ('OTA','META','DIRECT','WHOLESALE','OTHER')),
  CONSTRAINT channel_catalog_mode_check CHECK (integration_mode IN ('INTEGRATED','MANUAL')),
  CONSTRAINT channel_catalog_provider_check CHECK (provider_code ~ '^[A-Z0-9_]{2,40}$'),
  CONSTRAINT channel_catalog_name_check CHECK (char_length(display_name) BETWEEN 1 AND 100),
  CONSTRAINT channel_catalog_order_check CHECK (sort_order BETWEEN 0 AND 9999),
  CONSTRAINT channel_catalog_property_id_uq UNIQUE(property_id,id),
  CONSTRAINT channel_catalog_provider_uq UNIQUE(property_id,provider_code)
);
ALTER TABLE public.channel_catalog VALIDATE CONSTRAINT channel_catalog_property_fk;

CREATE TABLE public.property_channel_settings (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  catalog_id text NOT NULL,
  connection_id text,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  supplier_name text NOT NULL DEFAULT '',
  supplier_code text NOT NULL DEFAULT '',
  supplier_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_property_id text NOT NULL DEFAULT '',
  separate_management boolean NOT NULL DEFAULT false,
  sales_cutoff_days integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  CONSTRAINT property_channel_setting_property_fk FOREIGN KEY(property_id)
    REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID,
  CONSTRAINT property_channel_setting_catalog_fk FOREIGN KEY(property_id,catalog_id)
    REFERENCES public.channel_catalog(property_id,id) ON DELETE RESTRICT NOT VALID,
  CONSTRAINT property_channel_setting_connection_fk FOREIGN KEY(property_id,connection_id)
    REFERENCES public.channel_connections(property_id,id) ON DELETE SET NULL (connection_id) NOT VALID,
  CONSTRAINT property_channel_setting_json_check CHECK (jsonb_typeof(supplier_config)='object'),
  CONSTRAINT property_channel_setting_order_check CHECK (sort_order BETWEEN 0 AND 9999),
  CONSTRAINT property_channel_setting_cutoff_check CHECK (sales_cutoff_days BETWEEN 0 AND 730),
  CONSTRAINT property_channel_setting_version_check CHECK (version>=1),
  CONSTRAINT property_channel_setting_property_id_uq UNIQUE(property_id,id),
  CONSTRAINT property_channel_setting_catalog_uq UNIQUE(property_id,catalog_id),
  CONSTRAINT property_channel_setting_connection_uq UNIQUE(property_id,connection_id)
);
ALTER TABLE public.property_channel_settings VALIDATE CONSTRAINT property_channel_setting_property_fk;
ALTER TABLE public.property_channel_settings VALIDATE CONSTRAINT property_channel_setting_catalog_fk;
ALTER TABLE public.property_channel_settings VALIDATE CONSTRAINT property_channel_setting_connection_fk;

CREATE TABLE public.channel_product_cutoffs (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  setting_id text NOT NULL,
  rate_plan_id text NOT NULL,
  cutoff_days integer NOT NULL DEFAULT 0,
  cutoff_time time NOT NULL DEFAULT '23:59',
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  CONSTRAINT channel_product_cutoff_setting_fk FOREIGN KEY(property_id,setting_id)
    REFERENCES public.property_channel_settings(property_id,id) ON DELETE CASCADE NOT VALID,
  CONSTRAINT channel_product_cutoff_plan_fk FOREIGN KEY(property_id,rate_plan_id)
    REFERENCES public.rate_plans(property_id,id) ON DELETE RESTRICT NOT VALID,
  CONSTRAINT channel_product_cutoff_days_check CHECK (cutoff_days BETWEEN 0 AND 730),
  CONSTRAINT channel_product_cutoff_version_check CHECK (version>=1),
  CONSTRAINT channel_product_cutoff_uq UNIQUE(property_id,setting_id,rate_plan_id)
);
ALTER TABLE public.channel_product_cutoffs VALIDATE CONSTRAINT channel_product_cutoff_setting_fk;
ALTER TABLE public.channel_product_cutoffs VALIDATE CONSTRAINT channel_product_cutoff_plan_fk;

CREATE TABLE public.property_seasons (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  name text NOT NULL,
  season_type text NOT NULL DEFAULT 'PEAK',
  start_date date NOT NULL,
  end_date date NOT NULL,
  adjustment_type text NOT NULL DEFAULT 'NONE',
  adjustment numeric(14,4) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  CONSTRAINT property_season_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID,
  CONSTRAINT property_season_type_check CHECK (season_type IN ('PEAK','HIGH','SHOULDER','LOW','EVENT')),
  CONSTRAINT property_season_adjustment_type_check CHECK (adjustment_type IN ('NONE','AMOUNT','PERCENT')),
  CONSTRAINT property_season_dates_check CHECK (end_date>=start_date),
  CONSTRAINT property_season_name_check CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT property_season_uq UNIQUE(property_id,name,start_date,end_date)
);
ALTER TABLE public.property_seasons VALIDATE CONSTRAINT property_season_property_fk;

CREATE TABLE public.property_holidays (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  stay_date date NOT NULL,
  name text NOT NULL,
  holiday_type text NOT NULL DEFAULT 'PUBLIC',
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  CONSTRAINT property_holiday_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID,
  CONSTRAINT property_holiday_type_check CHECK (holiday_type IN ('PUBLIC','HOTEL','EVENT')),
  CONSTRAINT property_holiday_name_check CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT property_holiday_uq UNIQUE(property_id,stay_date,name)
);
ALTER TABLE public.property_holidays VALIDATE CONSTRAINT property_holiday_property_fk;

CREATE TABLE public.amenity_catalog (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'ROOM',
  icon_name text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  CONSTRAINT amenity_catalog_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID,
  CONSTRAINT amenity_catalog_category_check CHECK (category IN ('ROOM','BATH','FOOD','WELLNESS','ACCESSIBILITY','OTHER')),
  CONSTRAINT amenity_catalog_code_check CHECK (code ~ '^[A-Z0-9_]{2,40}$'),
  CONSTRAINT amenity_catalog_name_check CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT amenity_catalog_uq UNIQUE(property_id,code)
);
ALTER TABLE public.amenity_catalog VALIDATE CONSTRAINT amenity_catalog_property_fk;

CREATE TABLE public.service_catalog (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'OTHER',
  pricing_type text NOT NULL DEFAULT 'FIXED',
  price numeric(14,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KRW',
  description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  CONSTRAINT service_catalog_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID,
  CONSTRAINT service_catalog_category_check CHECK (category IN ('MEAL','TRANSPORT','SPA','EVENT','ROOM','OTHER')),
  CONSTRAINT service_catalog_pricing_check CHECK (pricing_type IN ('INCLUDED','FIXED','PER_PERSON','PER_NIGHT') AND price>=0),
  CONSTRAINT service_catalog_code_check CHECK (code ~ '^[A-Z0-9_]{2,40}$'),
  CONSTRAINT service_catalog_name_check CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT service_catalog_uq UNIQUE(property_id,code)
);
ALTER TABLE public.service_catalog VALIDATE CONSTRAINT service_catalog_property_fk;

ALTER TABLE public.channel_rate_overrides
  ADD COLUMN rate_plan_id text,
  ADD COLUMN allocation integer,
  ADD COLUMN closed boolean NOT NULL DEFAULT false,
  ADD COLUMN min_stay integer NOT NULL DEFAULT 1,
  ADD COLUMN close_to_arrival boolean NOT NULL DEFAULT false,
  ADD COLUMN close_to_departure boolean NOT NULL DEFAULT false;

UPDATE public.channel_rate_overrides o
   SET rate_plan_id=rp.id
  FROM public.channel_mappings m
  JOIN public.rate_plans rp ON rp.property_id=m.property_id AND rp.code=m.rate_plan
 WHERE m.id=o.mapping_id AND m.property_id=o.property_id AND o.rate_plan_id IS NULL;

ALTER TABLE public.channel_rate_overrides
  ADD CONSTRAINT channel_rate_override_plan_fk FOREIGN KEY(property_id,rate_plan_id)
    REFERENCES public.rate_plans(property_id,id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT channel_rate_override_allocation_check CHECK (allocation IS NULL OR allocation>=0) NOT VALID,
  ADD CONSTRAINT channel_rate_override_min_stay_check CHECK (min_stay BETWEEN 1 AND 365) NOT VALID;
ALTER TABLE public.channel_rate_overrides VALIDATE CONSTRAINT channel_rate_override_plan_fk;
ALTER TABLE public.channel_rate_overrides VALIDATE CONSTRAINT channel_rate_override_allocation_check;
ALTER TABLE public.channel_rate_overrides VALIDATE CONSTRAINT channel_rate_override_min_stay_check;
CREATE INDEX channel_rate_product_matrix_idx ON public.channel_rate_overrides(property_id,connection_id,rate_plan_id,room_type_id,stay_date);

CREATE OR REPLACE FUNCTION public.talos_channel_rate_block_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE mapping_row public.channel_mappings%ROWTYPE;
DECLARE plan_code text;
DECLARE room_count integer;
BEGIN
  SELECT * INTO mapping_row FROM public.channel_mappings
   WHERE id=NEW.mapping_id AND property_id=NEW.property_id AND active;
  IF NOT FOUND OR mapping_row.connection_id<>NEW.connection_id OR mapping_row.room_type_id<>NEW.room_type_id THEN
    RAISE EXCEPTION 'channel rate block mapping mismatch';
  END IF;
  SELECT code INTO plan_code FROM public.rate_plans
   WHERE id=NEW.rate_plan_id AND property_id=NEW.property_id AND active;
  IF plan_code IS NULL OR plan_code<>mapping_row.rate_plan THEN
    RAISE EXCEPTION 'channel rate block product mismatch';
  END IF;
  SELECT count(*) INTO room_count FROM public.rooms
   WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id
     AND active AND housekeeping_status<>'OUT_OF_SERVICE';
  IF NEW.allocation IS NOT NULL AND NEW.allocation>room_count THEN
    RAISE EXCEPTION 'channel allocation exceeds physical inventory';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER channel_rate_block_guard
BEFORE INSERT OR UPDATE ON public.channel_rate_overrides
FOR EACH ROW EXECUTE FUNCTION public.talos_channel_rate_block_guard();

INSERT INTO public.channel_catalog(id,property_id,provider_code,display_name,channel_class,integration_mode,description,sort_order,updated_by)
SELECT 'catalog-'||p.id||'-'||lower(v.code),p.id,v.code,v.name,v.class,v.mode,v.description,v.sort_order,'system:migration'
FROM public.properties p CROSS JOIN (VALUES
  ('AGODA','아고다','OTA','INTEGRATED','Agoda ARI·예약 연동',10),
  ('BOOKING_COM','부킹닷컴','OTA','INTEGRATED','Booking.com ARI·예약 연동',20),
  ('EXPEDIA','익스피디아','OTA','INTEGRATED','Expedia Group ARI·예약 연동',30),
  ('YANOLJA','야놀자','OTA','INTEGRATED','국내 OTA 연동',40),
  ('YEOGIEOTTAE','여기어때','OTA','INTEGRATED','국내 OTA 연동',50),
  ('MYREALTRIP','마이리얼트립','OTA','INTEGRATED','투어·숙박 채널 연동',60),
  ('NAVER','네이버 예약','META','MANUAL','별도 관리 메타 채널',70),
  ('ALLMYTOUR','올마이투어','WHOLESALE','INTEGRATED','B2B 공급 채널',80),
  ('DIRECT_WEB','공식 홈페이지','DIRECT','INTEGRATED','Talos 직접 예약',90),
  ('PHONE','전화 예약','DIRECT','MANUAL','호텔 자체 채널',100),
  ('WALK_IN','워크인','DIRECT','MANUAL','현장 예약',110),
  ('CORPORATE','기업 계약','WHOLESALE','MANUAL','기업·여행사 수기 채널',120)
) AS v(code,name,class,mode,description,sort_order)
ON CONFLICT(property_id,provider_code) DO NOTHING;

INSERT INTO public.channel_catalog(id,property_id,provider_code,display_name,channel_class,integration_mode,description,sort_order,updated_by)
SELECT 'catalog-'||c.property_id||'-'||lower(regexp_replace(c.provider,'[^A-Z0-9_]+','','g')),
       c.property_id,c.provider,c.name,'OTHER','INTEGRATED','기존 연결에서 이관',900,'system:migration'
FROM public.channel_connections c
ON CONFLICT(property_id,provider_code) DO NOTHING;

INSERT INTO public.property_channel_settings(id,property_id,catalog_id,connection_id,active,sort_order,external_property_id,updated_by)
SELECT 'channel-setting-'||c.id,c.property_id,cc.id,c.id,c.status='ACTIVE',cc.sort_order,c.external_property_id,'system:migration'
FROM public.channel_connections c
JOIN public.channel_catalog cc ON cc.property_id=c.property_id AND cc.provider_code=c.provider
ON CONFLICT(property_id,catalog_id) DO NOTHING;

INSERT INTO public.amenity_catalog(id,property_id,code,name,category,sort_order,updated_by)
SELECT 'amenity-'||p.id||'-'||lower(v.code),p.id,v.code,v.name,v.category,v.sort_order,'system:migration'
FROM public.properties p CROSS JOIN (VALUES
  ('WIFI','무료 Wi-Fi','ROOM',10),('SMART_TV','스마트 TV','ROOM',20),('PREMIUM_BED','프리미엄 침구','ROOM',30),
  ('BATHTUB','욕조','BATH',40),('BREAKFAST','조식','FOOD',50),('ACCESSIBLE','장애인 편의시설','ACCESSIBILITY',60)
) AS v(code,name,category,sort_order)
ON CONFLICT(property_id,code) DO NOTHING;

INSERT INTO public.service_catalog(id,property_id,code,name,category,pricing_type,price,sort_order,updated_by)
SELECT 'service-'||p.id||'-'||lower(v.code),p.id,v.code,v.name,v.category,v.pricing,v.price,v.sort_order,'system:migration'
FROM public.properties p CROSS JOIN (VALUES
  ('BREAKFAST','조식','MEAL','PER_PERSON',25000::numeric,10),
  ('LATE_CHECKOUT','레이트 체크아웃','ROOM','FIXED',50000::numeric,20),
  ('AIRPORT_PICKUP','공항 픽업','TRANSPORT','FIXED',120000::numeric,30)
) AS v(code,name,category,pricing,price,sort_order)
ON CONFLICT(property_id,code) DO NOTHING;

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'channel_catalog','property_channel_settings','channel_product_cutoffs',
    'property_seasons','property_holidays','amenity_catalog','service_catalog'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY aurora_property_isolation ON public.%I FOR ALL TO aurora_app USING (property_id=public.pms_current_property_id()) WITH CHECK (property_id=public.pms_current_property_id())',table_name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO aurora_app',table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon,authenticated',table_name);
  END LOOP;
END
$rls$;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607210023_channel_rateblock_operational_catalogs')
ON CONFLICT(id) DO NOTHING;

COMMIT;
