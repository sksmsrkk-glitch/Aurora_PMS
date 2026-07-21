-- HotelStory-compatible sale products, occupancy pricing, and immutable reservation snapshots.
BEGIN;

ALTER TABLE public.rate_plans
  ADD COLUMN package_type text NOT NULL DEFAULT 'NONE',
  ADD COLUMN parent_rate_plan_id text,
  ADD COLUMN sort_order integer NOT NULL DEFAULT 100,
  ADD COLUMN sellable_from timestamptz,
  ADD COLUMN sellable_to timestamptz,
  ADD COLUMN inclusions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN base_occupancy integer NOT NULL DEFAULT 2,
  ADD COLUMN max_occupancy integer NOT NULL DEFAULT 2;

ALTER TABLE public.rate_plans
  ADD CONSTRAINT rate_plan_meal_plan_check
    CHECK (meal_plan IN ('ROOM_ONLY','BREAKFAST','DINNER','HALF_BOARD','FULL_PACKAGE')) NOT VALID,
  ADD CONSTRAINT rate_plan_package_type_check
    CHECK (package_type IN ('NONE','HOMESHOPPING','UPGRADE_FCFS')) NOT VALID,
  ADD CONSTRAINT rate_plan_inclusions_array
    CHECK (jsonb_typeof(inclusions)='array') NOT VALID,
  ADD CONSTRAINT rate_plan_occupancy_bounds
    CHECK (base_occupancy BETWEEN 1 AND 20 AND max_occupancy BETWEEN base_occupancy AND 20) NOT VALID,
  ADD CONSTRAINT rate_plan_sell_window_check
    CHECK (sellable_to IS NULL OR sellable_from IS NULL OR sellable_to>=sellable_from) NOT VALID,
  ADD CONSTRAINT rate_plan_parent_not_self
    CHECK (parent_rate_plan_id IS NULL OR parent_rate_plan_id<>id) NOT VALID,
  ADD CONSTRAINT rate_plan_parent_fk
    FOREIGN KEY(property_id,parent_rate_plan_id)
    REFERENCES public.rate_plans(property_id,id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE public.rate_plans VALIDATE CONSTRAINT rate_plan_meal_plan_check;
ALTER TABLE public.rate_plans VALIDATE CONSTRAINT rate_plan_package_type_check;
ALTER TABLE public.rate_plans VALIDATE CONSTRAINT rate_plan_inclusions_array;
ALTER TABLE public.rate_plans VALIDATE CONSTRAINT rate_plan_occupancy_bounds;
ALTER TABLE public.rate_plans VALIDATE CONSTRAINT rate_plan_sell_window_check;
ALTER TABLE public.rate_plans VALIDATE CONSTRAINT rate_plan_parent_not_self;
ALTER TABLE public.rate_plans VALIDATE CONSTRAINT rate_plan_parent_fk;

CREATE TABLE public.rate_plan_occupancy (
  property_id text NOT NULL,
  rate_plan_id text NOT NULL,
  occupancy integer NOT NULL,
  extra_charge numeric(14,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  PRIMARY KEY(property_id,rate_plan_id,occupancy),
  CONSTRAINT rate_plan_occupancy_plan_fk
    FOREIGN KEY(property_id,rate_plan_id)
    REFERENCES public.rate_plans(property_id,id) ON DELETE CASCADE,
  CONSTRAINT rate_plan_occupancy_person_check CHECK (occupancy BETWEEN 1 AND 20),
  CONSTRAINT rate_plan_occupancy_charge_check CHECK (extra_charge>=0)
);

CREATE INDEX rate_plan_product_sort_idx
  ON public.rate_plans(property_id,active,sort_order,code);

-- A recursive parent chain is rejected before it can make effective-rate
-- calculation ambiguous. Parent and child are already constrained to one hotel.
CREATE OR REPLACE FUNCTION public.talos_rate_plan_parent_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE cycle_found boolean;
BEGIN
  IF NEW.parent_rate_plan_id IS NULL THEN RETURN NEW; END IF;
  WITH RECURSIVE ancestors(id,parent_rate_plan_id) AS (
    SELECT rp.id,rp.parent_rate_plan_id
      FROM public.rate_plans rp
     WHERE rp.property_id=NEW.property_id AND rp.id=NEW.parent_rate_plan_id
    UNION ALL
    SELECT rp.id,rp.parent_rate_plan_id
      FROM public.rate_plans rp JOIN ancestors a ON rp.id=a.parent_rate_plan_id
     WHERE rp.property_id=NEW.property_id
  )
  SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=NEW.id) INTO cycle_found;
  IF cycle_found THEN RAISE EXCEPTION 'rate plan parent cycle'; END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER rate_plan_parent_guard
BEFORE INSERT OR UPDATE OF parent_rate_plan_id ON public.rate_plans
FOR EACH ROW EXECUTE FUNCTION public.talos_rate_plan_parent_guard();

-- One function is shared by search and the reservation write backstop. It
-- resolves a date override first, then room-type base rate, parent inheritance,
-- and finally the exact occupancy supplement for the requested party size.
CREATE OR REPLACE FUNCTION public.talos_effective_product_rate(
  requested_property_id text,
  requested_rate_plan_id text,
  requested_room_type_id text,
  requested_stay_date date,
  requested_occupancy integer
) RETURNS numeric
LANGUAGE plpgsql STABLE AS $function$
DECLARE
  product public.rate_plans%ROWTYPE;
  base_rate numeric;
  calendar_rate numeric;
  parent_rate numeric;
  occupancy_charge numeric;
BEGIN
  SELECT * INTO product FROM public.rate_plans
   WHERE property_id=requested_property_id AND id=requested_rate_plan_id AND active;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF requested_occupancy<1 OR requested_occupancy>product.max_occupancy THEN RETURN NULL; END IF;

  SELECT rpc.sell_rate,rprt.base_rate INTO calendar_rate,base_rate
    FROM public.rate_plan_room_types rprt
    LEFT JOIN public.rate_plan_calendar rpc
      ON rpc.property_id=rprt.property_id
     AND rpc.rate_plan_id=rprt.rate_plan_id
     AND rpc.room_type_id=rprt.room_type_id
     AND rpc.stay_date=requested_stay_date
     AND NOT rpc.closed
   WHERE rprt.property_id=requested_property_id
     AND rprt.rate_plan_id=requested_rate_plan_id
     AND rprt.room_type_id=requested_room_type_id
     AND rprt.active;

  -- An explicit child-product date price wins. Without one, a derived product
  -- follows its parent date/base price and applies the configured adjustment.
  IF calendar_rate IS NOT NULL THEN
    base_rate := calendar_rate;
  ELSIF product.parent_rate_plan_id IS NOT NULL AND product.pricing_model IN ('OFFSET','PERCENT') THEN
    SELECT COALESCE(rpc.sell_rate,rprt.base_rate) INTO parent_rate
      FROM public.rate_plan_room_types rprt
      LEFT JOIN public.rate_plan_calendar rpc
        ON rpc.property_id=rprt.property_id
       AND rpc.rate_plan_id=rprt.rate_plan_id
       AND rpc.room_type_id=rprt.room_type_id
       AND rpc.stay_date=requested_stay_date
       AND NOT rpc.closed
     WHERE rprt.property_id=requested_property_id
       AND rprt.rate_plan_id=product.parent_rate_plan_id
       AND rprt.room_type_id=requested_room_type_id
       AND rprt.active;
    IF parent_rate IS NULL THEN RETURN NULL; END IF;
    base_rate := CASE product.pricing_model
      WHEN 'OFFSET' THEN parent_rate+product.adjustment
      WHEN 'PERCENT' THEN parent_rate*(1+product.adjustment/100)
      ELSE base_rate
    END;
  END IF;

  IF base_rate IS NULL THEN RETURN NULL; END IF;

  SELECT extra_charge INTO occupancy_charge
    FROM public.rate_plan_occupancy
   WHERE property_id=requested_property_id
     AND rate_plan_id=requested_rate_plan_id
     AND occupancy=requested_occupancy;
  RETURN round(GREATEST(0,COALESCE(base_rate,0)+COALESCE(occupancy_charge,0)),2);
END
$function$;

ALTER TABLE public.reservations
  ADD COLUMN rate_plan_id text,
  ADD COLUMN rate_plan_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN occupancy_detail jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Existing rows are linked and snapshotted without changing their historical
-- monetary columns. Every repair is recorded before the data is modified.
INSERT INTO public.audit_logs(
  id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at
)
SELECT
  'migration-020-product-'||r.id,r.property_id,'system:migration',
  'LINK_RESERVATION_PRODUCT','reservation',r.id,
  jsonb_build_object('ratePlan',r.rate_plan),
  jsonb_build_object('ratePlanId',rp.id,'ratePlan',rp.code),clock_timestamp()
FROM public.reservations r
JOIN public.rate_plans rp ON rp.property_id=r.property_id AND rp.code=r.rate_plan
WHERE r.rate_plan_id IS NULL
ON CONFLICT(id) DO NOTHING;

UPDATE public.reservations r
SET rate_plan_id=rp.id,
    rate_plan_snapshot=jsonb_build_object(
      'id',rp.id,'code',rp.code,'name',rp.name,'mealPlan',rp.meal_plan,
      'packageType',rp.package_type,'inclusions',rp.inclusions,
      'cancellationPolicy',rp.cancellation_policy,
      'guaranteePolicy',rp.guarantee_policy,'currency',rp.currency
    ),
    occupancy_detail=jsonb_build_object('adults',r.adults,'children',r.children)
FROM public.rate_plans rp
WHERE rp.property_id=r.property_id AND rp.code=r.rate_plan AND r.rate_plan_id IS NULL;

ALTER TABLE public.reservations
  ADD CONSTRAINT reservation_rate_plan_id_fk
    FOREIGN KEY(property_id,rate_plan_id)
    REFERENCES public.rate_plans(property_id,id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT reservation_rate_plan_snapshot_object
    CHECK (jsonb_typeof(rate_plan_snapshot)='object') NOT VALID,
  ADD CONSTRAINT reservation_occupancy_detail_object
    CHECK (jsonb_typeof(occupancy_detail)='object') NOT VALID;
ALTER TABLE public.reservations VALIDATE CONSTRAINT reservation_rate_plan_id_fk;
ALTER TABLE public.reservations VALIDATE CONSTRAINT reservation_rate_plan_snapshot_object;
ALTER TABLE public.reservations VALIDATE CONSTRAINT reservation_occupancy_detail_object;

CREATE OR REPLACE FUNCTION public.talos_reservation_product_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE product public.rate_plans%ROWTYPE;
BEGIN
  IF NEW.rate_plan_id IS NULL THEN
    SELECT id INTO NEW.rate_plan_id FROM public.rate_plans
     WHERE property_id=NEW.property_id AND code=NEW.rate_plan;
  END IF;
  IF NEW.rate_plan_id IS NULL THEN RAISE EXCEPTION 'valid rate plan is required'; END IF;

  -- OLD is undefined for INSERT triggers, so keep the two operation paths
  -- separate instead of relying on boolean short-circuit evaluation.
  IF TG_OP='INSERT' THEN
    SELECT * INTO product FROM public.rate_plans
     WHERE property_id=NEW.property_id AND id=NEW.rate_plan_id AND active;
    IF NOT FOUND THEN RAISE EXCEPTION 'active rate plan is required'; END IF;
  ELSIF NEW.rate_plan_id IS DISTINCT FROM OLD.rate_plan_id
     OR NEW.rate_plan_snapshot='{}'::jsonb THEN
    SELECT * INTO product FROM public.rate_plans
     WHERE property_id=NEW.property_id AND id=NEW.rate_plan_id AND active;
    IF NOT FOUND THEN RAISE EXCEPTION 'active rate plan is required'; END IF;
  END IF;

  IF TG_OP='INSERT'
     OR NEW.rate_plan_id IS DISTINCT FROM OLD.rate_plan_id
     OR NEW.rate_plan_snapshot='{}'::jsonb THEN
    NEW.rate_plan := product.code;
    NEW.rate_plan_snapshot := jsonb_build_object(
      'id',product.id,'code',product.code,'name',product.name,
      'mealPlan',product.meal_plan,'packageType',product.package_type,
      'inclusions',product.inclusions,
      'cancellationPolicy',product.cancellation_policy,
      'guaranteePolicy',product.guarantee_policy,'currency',product.currency
    );
  END IF;
  NEW.occupancy_detail := jsonb_build_object('adults',NEW.adults,'children',NEW.children);
  RETURN NEW;
END
$function$;

CREATE TRIGGER reservation_product_snapshot_guard
BEFORE INSERT OR UPDATE OF rate_plan_id,rate_plan,adults,children
ON public.reservations
FOR EACH ROW EXECUTE FUNCTION public.talos_reservation_product_snapshot();

DO $tenant_rls$
DECLARE tables text[] := ARRAY['rate_plan_occupancy'];
DECLARE tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY tables LOOP
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
$tenant_rls$;

REVOKE ALL ON FUNCTION public.talos_effective_product_rate(text,text,text,date,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.talos_effective_product_rate(text,text,text,date,integer) TO aurora_app;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607210020_rate_product_catalog')
ON CONFLICT(id) DO NOTHING;

COMMIT;
