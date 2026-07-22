-- Closes separated-PAN storage, completes channel product backfill, and makes
-- both contracts enforceable for every future application version.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE TEMP TABLE talos_pci_redactions ON COMMIT DROP AS
SELECT id,property_id,card_info_ref
  FROM public.reservations
 WHERE card_info_ref IS NOT NULL
   AND char_length(regexp_replace(card_info_ref,'[^0-9]','','g'))>=12;

INSERT INTO public.audit_logs(
  id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at
)
SELECT 'migration-0027-pci-'||md5(property_id||id),property_id,
       'system:migration','REDACT_PLAINTEXT_CARD_REFERENCE','reservation',id,
       jsonb_build_object('cardReferenceRemoved',true),
       jsonb_build_object('cardInfoRef',NULL),clock_timestamp()
  FROM talos_pci_redactions
ON CONFLICT(id) DO NOTHING;

UPDATE public.reservations r
   SET card_info_ref=NULL,updated_at=clock_timestamp()
  FROM talos_pci_redactions unsafe
 WHERE unsafe.property_id=r.property_id AND unsafe.id=r.id;

ALTER TABLE public.reservations
  DROP CONSTRAINT reservation_card_reference_pci_check,
  ADD CONSTRAINT reservation_card_reference_pci_check CHECK (
    card_info_ref IS NULL OR (
      char_length(card_info_ref)<=160
      AND char_length(regexp_replace(card_info_ref,'[^0-9]','','g'))<12
    )
  ) NOT VALID;
ALTER TABLE public.reservations
  VALIDATE CONSTRAINT reservation_card_reference_pci_check;

WITH repaired AS (
  UPDATE public.channel_rate_overrides o
     SET rate_plan_id=rp.id
    FROM public.channel_mappings m
    JOIN public.rate_plans rp
      ON rp.property_id=m.property_id AND rp.code=m.rate_plan
   WHERE m.id=o.mapping_id
     AND m.property_id=o.property_id
     AND o.rate_plan_id IS NULL
  RETURNING o.id,o.property_id,o.rate_plan_id
)
INSERT INTO public.audit_logs(
  id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at
)
SELECT 'migration-0027-rate-'||md5(property_id||id),property_id,
       'system:migration','BACKFILL_CHANNEL_RATE_PLAN','channel_rate_override',id,
       jsonb_build_object('ratePlanId',NULL),
       jsonb_build_object('ratePlanId',rate_plan_id),clock_timestamp()
  FROM repaired
ON CONFLICT(id) DO NOTHING;

DO $integrity$
BEGIN
  IF EXISTS(SELECT 1 FROM public.channel_rate_overrides WHERE rate_plan_id IS NULL) THEN
    RAISE EXCEPTION 'channel_rate_overrides contains unmapped rate plans; create the matching rate_plan before retrying migration 0027';
  END IF;
END
$integrity$;

ALTER TABLE public.channel_rate_overrides
  ADD CONSTRAINT channel_rate_override_plan_required
    CHECK (rate_plan_id IS NOT NULL) NOT VALID;
ALTER TABLE public.channel_rate_overrides
  VALIDATE CONSTRAINT channel_rate_override_plan_required;
ALTER TABLE public.channel_rate_overrides
  ALTER COLUMN rate_plan_id SET NOT NULL;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607220027_import_pci_rate_override_integrity')
ON CONFLICT (id) DO NOTHING;

COMMIT;
