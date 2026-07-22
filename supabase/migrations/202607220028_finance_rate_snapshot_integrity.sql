-- Completes financial reversal equality, multi-level rate inheritance, and
-- immutable reservation product snapshots without editing historical SQL.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.pms_channel_deposit_event_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_status text;
  current_journal text;
  receipt_journal text;
  receipt_amount numeric(14,2);
BEGIN
  SELECT status,payment_journal_id INTO current_status,current_journal
    FROM public.channel_settlements
   WHERE property_id=NEW.property_id AND id=NEW.settlement_id
   FOR UPDATE;
  IF NEW.event_type='RECEIPT' THEN
    IF current_status<>'PAID' OR current_journal IS DISTINCT FROM NEW.accounting_journal_id THEN
      RAISE EXCEPTION 'receipt must match the current paid settlement journal';
    END IF;
  ELSE
    SELECT accounting_journal_id,amount INTO receipt_journal,receipt_amount
      FROM public.channel_deposit_events
     WHERE property_id=NEW.property_id AND id=NEW.reverses_event_id
       AND settlement_id=NEW.settlement_id AND event_type='RECEIPT';
    IF receipt_journal IS NULL OR current_status<>'PAID' OR current_journal IS DISTINCT FROM receipt_journal THEN
      RAISE EXCEPTION 'restore must reverse the current paid settlement receipt';
    END IF;
    IF NEW.amount IS DISTINCT FROM receipt_amount THEN
      RAISE EXCEPTION 'restore amount must match the original receipt';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

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
  requested_product public.rate_plans%ROWTYPE;
  chain text[] := ARRAY[]::text[];
  current_id text := requested_rate_plan_id;
  own_base numeric;
  calendar_rate numeric;
  effective_rate numeric;
  occupancy_charge numeric;
  depth integer := 0;
  position integer;
BEGIN
  SELECT * INTO requested_product FROM public.rate_plans
   WHERE property_id=requested_property_id AND id=requested_rate_plan_id AND active;
  IF NOT FOUND OR requested_occupancy<1 OR requested_occupancy>requested_product.max_occupancy THEN
    RETURN NULL;
  END IF;

  WHILE current_id IS NOT NULL LOOP
    depth := depth+1;
    IF depth>64 OR array_position(chain,current_id) IS NOT NULL THEN RETURN NULL; END IF;
    SELECT * INTO product FROM public.rate_plans
     WHERE property_id=requested_property_id AND id=current_id AND active;
    IF NOT FOUND THEN RETURN NULL; END IF;
    chain := array_append(chain,product.id);
    current_id := product.parent_rate_plan_id;
  END LOOP;

  FOR position IN REVERSE array_length(chain,1)..1 LOOP
    SELECT * INTO product FROM public.rate_plans
     WHERE property_id=requested_property_id AND id=chain[position] AND active;
    SELECT rpc.sell_rate,rprt.base_rate INTO calendar_rate,own_base
      FROM public.rate_plan_room_types rprt
      LEFT JOIN public.rate_plan_calendar rpc
        ON rpc.property_id=rprt.property_id
       AND rpc.rate_plan_id=rprt.rate_plan_id
       AND rpc.room_type_id=rprt.room_type_id
       AND rpc.stay_date=requested_stay_date
       AND NOT rpc.closed
     WHERE rprt.property_id=requested_property_id
       AND rprt.rate_plan_id=product.id
       AND rprt.room_type_id=requested_room_type_id
       AND rprt.active;

    IF calendar_rate IS NOT NULL THEN
      effective_rate := calendar_rate;
    ELSIF product.parent_rate_plan_id IS NULL OR product.pricing_model='FIXED' THEN
      effective_rate := own_base;
    ELSIF effective_rate IS NULL THEN
      RETURN NULL;
    ELSIF product.pricing_model='OFFSET' THEN
      effective_rate := effective_rate+product.adjustment;
    ELSIF product.pricing_model='PERCENT' THEN
      effective_rate := effective_rate*(1+product.adjustment/100);
    ELSE
      RETURN NULL;
    END IF;
    IF effective_rate IS NULL THEN RETURN NULL; END IF;
  END LOOP;

  SELECT extra_charge INTO occupancy_charge
    FROM public.rate_plan_occupancy
   WHERE property_id=requested_property_id
     AND rate_plan_id=requested_rate_plan_id
     AND occupancy=requested_occupancy;
  RETURN round(GREATEST(0,effective_rate+COALESCE(occupancy_charge,0)),2);
END
$function$;

INSERT INTO public.audit_logs(
  id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at
)
SELECT 'migration-0028-snapshot-'||md5(r.property_id||r.id),r.property_id,
       'system:migration','REPAIR_EMPTY_RATE_PLAN_SNAPSHOT','reservation',r.id,
       jsonb_build_object('ratePlanSnapshot','{}'::jsonb),
       jsonb_build_object('ratePlanId',rp.id,'ratePlanCode',rp.code),clock_timestamp()
  FROM public.reservations r
  JOIN public.rate_plans rp
    ON rp.property_id=r.property_id
   AND (rp.id=r.rate_plan_id OR (r.rate_plan_id IS NULL AND rp.code=r.rate_plan))
 WHERE r.rate_plan_snapshot='{}'::jsonb
ON CONFLICT(id) DO NOTHING;

UPDATE public.reservations r
   SET rate_plan_id=rp.id,
       rate_plan=rp.code,
       rate_plan_snapshot=jsonb_build_object(
         'id',rp.id,'code',rp.code,'name',rp.name,'mealPlan',rp.meal_plan,
         'packageType',rp.package_type,'inclusions',rp.inclusions,
         'cancellationPolicy',rp.cancellation_policy,
         'cancellationTerms',rp.cancellation_terms,
         'guaranteePolicy',rp.guarantee_policy,'currency',rp.currency
       ),
       updated_at=clock_timestamp()
  FROM public.rate_plans rp
 WHERE r.rate_plan_snapshot='{}'::jsonb
   AND rp.property_id=r.property_id
   AND (rp.id=r.rate_plan_id OR (r.rate_plan_id IS NULL AND rp.code=r.rate_plan));

-- A legacy free-text product may have no current master row. Preserve the
-- historical header as an explicit snapshot instead of silently substituting
-- a modern policy or blocking the integrity upgrade.
INSERT INTO public.audit_logs(
  id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at
)
SELECT 'migration-0028-legacy-'||md5(r.property_id||r.id),r.property_id,
       'system:migration','PRESERVE_LEGACY_RATE_PLAN_SNAPSHOT','reservation',r.id,
       jsonb_build_object('ratePlanSnapshot','{}'::jsonb),
       jsonb_build_object('ratePlanCode',r.rate_plan,'source','reservation-header'),clock_timestamp()
  FROM public.reservations r
 WHERE r.rate_plan_snapshot='{}'::jsonb
ON CONFLICT(id) DO NOTHING;

UPDATE public.reservations r
   SET rate_plan_snapshot=jsonb_build_object(
         'id',r.rate_plan_id,'code',r.rate_plan,'name',r.rate_plan,
         'mealPlan','ROOM_ONLY','packageType','NONE','inclusions','[]'::jsonb,
         'cancellationPolicy','LEGACY','cancellationTerms','[]'::jsonb,
         'guaranteePolicy','LEGACY','currency',p.currency,
         'source','reservation-header'
       ),
       updated_at=clock_timestamp()
  FROM public.properties p
 WHERE r.property_id=p.id AND r.rate_plan_snapshot='{}'::jsonb;

ALTER TABLE public.reservations
  ADD CONSTRAINT reservation_rate_plan_snapshot_nonempty
    CHECK (rate_plan_snapshot<>'{}'::jsonb) NOT VALID;
ALTER TABLE public.reservations
  VALIDATE CONSTRAINT reservation_rate_plan_snapshot_nonempty;

CREATE OR REPLACE FUNCTION public.talos_reservation_product_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE product public.rate_plans%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.rate_plan_id IS NULL THEN
      SELECT id INTO NEW.rate_plan_id FROM public.rate_plans
       WHERE property_id=NEW.property_id AND code=NEW.rate_plan;
    END IF;
    SELECT * INTO product FROM public.rate_plans
     WHERE property_id=NEW.property_id AND id=NEW.rate_plan_id AND active;
    IF NOT FOUND THEN RAISE EXCEPTION 'active rate plan is required'; END IF;
  ELSIF NEW.rate_plan_id IS DISTINCT FROM OLD.rate_plan_id THEN
    SELECT * INTO product FROM public.rate_plans
     WHERE property_id=NEW.property_id AND id=NEW.rate_plan_id AND active;
    IF NOT FOUND THEN RAISE EXCEPTION 'active rate plan is required'; END IF;
  ELSE
    IF NEW.rate_plan IS DISTINCT FROM OLD.rate_plan
       OR NEW.rate_plan_snapshot IS DISTINCT FROM OLD.rate_plan_snapshot THEN
      RAISE EXCEPTION 'reservation rate plan snapshot is immutable; change rate_plan_id explicitly';
    END IF;
  END IF;

  IF TG_OP='INSERT' OR NEW.rate_plan_id IS DISTINCT FROM OLD.rate_plan_id THEN
    NEW.rate_plan := product.code;
    NEW.rate_plan_snapshot := jsonb_build_object(
      'id',product.id,'code',product.code,'name',product.name,
      'mealPlan',product.meal_plan,'packageType',product.package_type,
      'inclusions',product.inclusions,
      'cancellationPolicy',product.cancellation_policy,
      'cancellationTerms',product.cancellation_terms,
      'guaranteePolicy',product.guarantee_policy,'currency',product.currency
    );
  END IF;
  NEW.occupancy_detail := jsonb_build_object('adults',NEW.adults,'children',NEW.children);
  RETURN NEW;
END
$function$;

DROP TRIGGER reservation_product_snapshot_guard ON public.reservations;
CREATE TRIGGER reservation_product_snapshot_guard
BEFORE INSERT OR UPDATE OF rate_plan_id,rate_plan,rate_plan_snapshot,adults,children
ON public.reservations
FOR EACH ROW EXECUTE FUNCTION public.talos_reservation_product_snapshot();

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607220028_finance_rate_snapshot_integrity')
ON CONFLICT(id) DO NOTHING;

COMMIT;
