-- HotelStory-compatible reservation operations: distinct booker/staying guest,
-- operational options, immutable cancellation terms, links, and inline history.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.rate_plans
  ADD COLUMN cancellation_terms jsonb NOT NULL DEFAULT
    '[{"basis":"체크인 3일 전까지","allowed":true,"feePercent":0},{"basis":"체크인 2일 전부터 당일","allowed":false,"feePercent":100}]'::jsonb;

ALTER TABLE public.rate_plans
  ADD CONSTRAINT rate_plan_cancellation_terms_array
    CHECK (jsonb_typeof(cancellation_terms)='array') NOT VALID;
ALTER TABLE public.rate_plans VALIDATE CONSTRAINT rate_plan_cancellation_terms_array;

ALTER TABLE public.reservations
  -- The temporary safe default preserves migration-before-code deploy order.
  -- Every upgraded write path supplies the real booker explicitly.
  ADD COLUMN booker_name text NOT NULL DEFAULT '미지정',
  ADD COLUMN booker_phone text,
  ADD COLUMN booker_email text,
  ADD COLUMN channel_product_name text,
  ADD COLUMN payment_type text NOT NULL DEFAULT 'HOTEL',
  ADD COLUMN guest_request text NOT NULL DEFAULT '',
  ADD COLUMN guest_request_response text NOT NULL DEFAULT '',
  ADD COLUMN manager_memo text NOT NULL DEFAULT '',
  ADD COLUMN hotel_memo text NOT NULL DEFAULT '',
  ADD COLUMN reservation_checked boolean NOT NULL DEFAULT false,
  ADD COLUMN early_checkin boolean NOT NULL DEFAULT false,
  ADD COLUMN early_checkin_time time,
  ADD COLUMN late_checkout boolean NOT NULL DEFAULT false,
  ADD COLUMN late_checkout_time time,
  ADD COLUMN card_info_ref text,
  ADD COLUMN service_fee_included boolean NOT NULL DEFAULT false;

ALTER TABLE public.reservations
  ADD CONSTRAINT reservation_booker_name_length CHECK (char_length(booker_name) BETWEEN 1 AND 120) NOT VALID,
  ADD CONSTRAINT reservation_booker_phone_length CHECK (booker_phone IS NULL OR char_length(booker_phone)<=40) NOT VALID,
  ADD CONSTRAINT reservation_booker_email_length CHECK (booker_email IS NULL OR char_length(booker_email)<=254) NOT VALID,
  ADD CONSTRAINT reservation_payment_type_check CHECK (payment_type IN ('HOTEL','PREPAID','CHANNEL','DIRECT_BILL')) NOT VALID,
  ADD CONSTRAINT reservation_operational_memo_lengths CHECK (
    char_length(guest_request)<=2000 AND char_length(guest_request_response)<=2000
    AND char_length(manager_memo)<=2000 AND char_length(hotel_memo)<=2000
  ) NOT VALID,
  ADD CONSTRAINT reservation_early_checkin_time_check CHECK (
    (early_checkin AND early_checkin_time IS NOT NULL)
    OR (NOT early_checkin AND early_checkin_time IS NULL)
  ) NOT VALID,
  ADD CONSTRAINT reservation_late_checkout_time_check CHECK (
    (late_checkout AND late_checkout_time IS NOT NULL)
    OR (NOT late_checkout AND late_checkout_time IS NULL)
  ) NOT VALID,
  -- Store only a gateway token or a masked PAN suffix. A raw 12+ digit PAN is rejected.
  ADD CONSTRAINT reservation_card_reference_pci_check CHECK (
    card_info_ref IS NULL OR (char_length(card_info_ref)<=160 AND card_info_ref !~ '[0-9]{12,}')
  ) NOT VALID;

WITH changed AS (
  UPDATE public.reservations r
     SET booker_name=concat_ws(' ',g.first_name,g.last_name),
         booker_phone=g.phone,
         booker_email=g.email,
         channel_product_name=COALESCE(NULLIF(r.rate_plan_snapshot->>'name',''),r.rate_plan),
         rate_plan_snapshot=r.rate_plan_snapshot || jsonb_build_object(
           'cancellationTerms',COALESCE((
             SELECT rp.cancellation_terms
               FROM public.rate_plans rp
              WHERE rp.property_id=r.property_id AND rp.id=r.rate_plan_id
           ),'[]'::jsonb)
         )
    FROM public.guests g
   WHERE g.property_id=r.property_id AND g.id=r.guest_id
  RETURNING r.id,r.property_id,r.booker_name,r.rate_plan_snapshot
)
INSERT INTO public.audit_logs(
  id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at
)
SELECT 'migration-0021-'||md5(property_id||id),property_id,'migration:202607210021',
       'BACKFILL_RESERVATION_DETAIL','reservation',id,NULL,
       jsonb_build_object('bookerName',booker_name,'ratePlanSnapshot',rate_plan_snapshot),clock_timestamp()
  FROM changed
ON CONFLICT(id) DO NOTHING;

ALTER TABLE public.reservations
  VALIDATE CONSTRAINT reservation_booker_name_length;
ALTER TABLE public.reservations
  VALIDATE CONSTRAINT reservation_booker_phone_length;
ALTER TABLE public.reservations
  VALIDATE CONSTRAINT reservation_booker_email_length;
ALTER TABLE public.reservations
  VALIDATE CONSTRAINT reservation_payment_type_check;
ALTER TABLE public.reservations
  VALIDATE CONSTRAINT reservation_operational_memo_lengths;
ALTER TABLE public.reservations
  VALIDATE CONSTRAINT reservation_early_checkin_time_check;
ALTER TABLE public.reservations
  VALIDATE CONSTRAINT reservation_late_checkout_time_check;
ALTER TABLE public.reservations
  VALIDATE CONSTRAINT reservation_card_reference_pci_check;

CREATE TABLE public.reservation_links (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  reservation_id text NOT NULL,
  linked_reservation_id text NOT NULL,
  relation_type text NOT NULL DEFAULT 'COMPANION',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL,
  CONSTRAINT reservation_link_distinct CHECK (reservation_id<>linked_reservation_id),
  CONSTRAINT reservation_link_relation_check CHECK (relation_type IN ('COMPANION','CONSECUTIVE','GROUP')),
  CONSTRAINT reservation_link_notes_length CHECK (char_length(notes)<=500),
  CONSTRAINT reservation_links_property_fk FOREIGN KEY(property_id)
    REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID,
  CONSTRAINT reservation_links_source_fk FOREIGN KEY(property_id,reservation_id)
    REFERENCES public.reservations(property_id,id) ON DELETE CASCADE NOT VALID,
  CONSTRAINT reservation_links_target_fk FOREIGN KEY(property_id,linked_reservation_id)
    REFERENCES public.reservations(property_id,id) ON DELETE CASCADE NOT VALID,
  CONSTRAINT reservation_links_pair_uq UNIQUE(property_id,reservation_id,linked_reservation_id)
);

ALTER TABLE public.reservation_links VALIDATE CONSTRAINT reservation_links_property_fk;
ALTER TABLE public.reservation_links VALIDATE CONSTRAINT reservation_links_source_fk;
ALTER TABLE public.reservation_links VALIDATE CONSTRAINT reservation_links_target_fk;
CREATE INDEX reservation_links_target_idx ON public.reservation_links(property_id,linked_reservation_id,created_at DESC);

ALTER TABLE public.reservation_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservation_links FORCE ROW LEVEL SECURITY;
CREATE POLICY aurora_property_isolation ON public.reservation_links
  FOR ALL TO aurora_app
  USING (property_id=public.pms_current_property_id())
  WITH CHECK (property_id=public.pms_current_property_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.reservation_links TO aurora_app;
REVOKE ALL ON TABLE public.reservation_links FROM anon,authenticated;

CREATE OR REPLACE FUNCTION public.talos_reservation_product_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE product public.rate_plans%ROWTYPE;
BEGIN
  IF NEW.rate_plan_id IS NULL THEN
    SELECT id INTO NEW.rate_plan_id FROM public.rate_plans
     WHERE property_id=NEW.property_id AND code=NEW.rate_plan;
  END IF;
  IF NEW.rate_plan_id IS NULL THEN RAISE EXCEPTION 'valid rate plan is required'; END IF;

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
      'cancellationTerms',product.cancellation_terms,
      'guaranteePolicy',product.guarantee_policy,'currency',product.currency
    );
  END IF;
  NEW.occupancy_detail := jsonb_build_object('adults',NEW.adults,'children',NEW.children);
  RETURN NEW;
END
$function$;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607210021_reservation_operational_detail')
ON CONFLICT(id) DO NOTHING;

COMMIT;
