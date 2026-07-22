-- Closes parent-chain termination and records provenance for historical repairs.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Historical migrations 0016 and 0023 predate the current rule requiring a
-- tenant audit record for every repair. Their exact before-images cannot be
-- reconstructed safely, so this forward-only migration records the surviving
-- row and source migration without fabricating history.
INSERT INTO public.audit_logs(
  id,property_id,actor,action,entity_type,entity_id,
  before_json,after_json,created_at
)
SELECT 'migration-0029-property-'||md5(p.id),p.id,'system:migration',
       'HISTORICAL_REPAIR_PROVENANCE','property',p.id,NULL,
       jsonb_build_object(
         'sourceMigration','202607190016_multihotel_saas_control_plane',
         'organizationId',p.organization_id,'slug',p.slug,
         'provenance','current-state-only'
       ),clock_timestamp()
  FROM public.properties p
ON CONFLICT(id) DO NOTHING;

INSERT INTO public.audit_logs(
  id,property_id,actor,action,entity_type,entity_id,
  before_json,after_json,created_at
)
SELECT 'migration-0029-override-'||md5(o.property_id||o.id),o.property_id,
       'system:migration','HISTORICAL_REPAIR_PROVENANCE',
       'channel_rate_override',o.id,NULL,
       jsonb_build_object(
         'sourceMigration','202607210023_channel_rateblock_operational_catalogs',
         'ratePlanId',o.rate_plan_id,'provenance','current-state-only'
       ),clock_timestamp()
  FROM public.channel_rate_overrides o
 WHERE o.rate_plan_id IS NOT NULL
ON CONFLICT(id) DO NOTHING;

-- A pre-existing legacy cycle must terminate deterministically. The recursive
-- term emits one final cycle-marked row, then stops; chains are also capped at
-- 64 products so malformed legacy data cannot hang a write transaction.
CREATE OR REPLACE FUNCTION public.talos_rate_plan_parent_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  cycle_found boolean := false;
  chain_cycle boolean := false;
  depth_exceeded boolean := false;
BEGIN
  IF NEW.parent_rate_plan_id IS NULL THEN RETURN NEW; END IF;

  WITH RECURSIVE ancestors(id,parent_rate_plan_id,path,depth,cycle) AS (
    SELECT rp.id,rp.parent_rate_plan_id,ARRAY[rp.id]::text[],1,false
      FROM public.rate_plans rp
     WHERE rp.property_id=NEW.property_id AND rp.id=NEW.parent_rate_plan_id
    UNION ALL
    SELECT rp.id,rp.parent_rate_plan_id,a.path||rp.id,a.depth+1,
           rp.id=ANY(a.path)
      FROM public.rate_plans rp
      JOIN ancestors a ON rp.id=a.parent_rate_plan_id
     WHERE rp.property_id=NEW.property_id
       AND a.depth<64
       AND NOT a.cycle
  )
  SELECT COALESCE(bool_or(id=NEW.id),false),
         COALESCE(bool_or(cycle),false),
         COALESCE(bool_or(depth=64 AND parent_rate_plan_id IS NOT NULL AND NOT cycle),false)
    INTO cycle_found,chain_cycle,depth_exceeded
    FROM ancestors;

  IF cycle_found OR chain_cycle THEN
    RAISE EXCEPTION 'rate plan parent cycle';
  END IF;
  IF depth_exceeded THEN
    RAISE EXCEPTION 'rate plan parent chain exceeds 64 products';
  END IF;
  RETURN NEW;
END
$function$;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607220029_quality_integrity_closure')
ON CONFLICT(id) DO NOTHING;

COMMIT;
