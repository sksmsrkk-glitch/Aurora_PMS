BEGIN;
ALTER TABLE public.channel_settlements ADD COLUMN IF NOT EXISTS contract_type text;
ALTER TABLE public.channel_settlements ADD COLUMN IF NOT EXISTS commission_percent numeric(7,4);
UPDATE public.channel_settlements s
SET contract_type=c.contract_type,commission_percent=c.commission_percent
FROM public.channel_contracts c
WHERE c.id=s.contract_id AND (s.contract_type IS NULL OR s.commission_percent IS NULL);
ALTER TABLE public.channel_settlements ALTER COLUMN contract_type SET NOT NULL;
ALTER TABLE public.channel_settlements ALTER COLUMN commission_percent SET NOT NULL;
ALTER TABLE public.channel_settlements ADD CONSTRAINT channel_settlement_contract_type_ck CHECK (contract_type IN ('COMMISSION','NET_RATE'));
ALTER TABLE public.channel_settlements ADD CONSTRAINT channel_settlement_commission_ck CHECK (commission_percent >= 0 AND commission_percent <= 100);
CREATE OR REPLACE FUNCTION public.pms_channel_settlement_contract_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT contract_type,commission_percent INTO NEW.contract_type,NEW.commission_percent
  FROM public.channel_contracts WHERE id=NEW.contract_id AND connection_id=NEW.connection_id;
  IF NEW.contract_type IS NULL THEN RAISE EXCEPTION 'valid channel contract is required'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS channel_settlement_contract_snapshot_insert ON public.channel_settlements;
CREATE TRIGGER channel_settlement_contract_snapshot_insert BEFORE INSERT ON public.channel_settlements FOR EACH ROW EXECUTE FUNCTION public.pms_channel_settlement_contract_snapshot();
CREATE OR REPLACE FUNCTION public.pms_channel_contract_open_settlement_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.contract_type<>NEW.contract_type OR OLD.commission_percent<>NEW.commission_percent)
     AND EXISTS (SELECT 1 FROM public.channel_settlements s WHERE s.contract_id=OLD.id AND s.status='ACCRUED') THEN
    RAISE EXCEPTION 'pay or void accrued settlements before changing contract terms';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS channel_contract_open_settlement_guard_update ON public.channel_contracts;
CREATE TRIGGER channel_contract_open_settlement_guard_update BEFORE UPDATE ON public.channel_contracts FOR EACH ROW EXECUTE FUNCTION public.pms_channel_contract_open_settlement_guard();
INSERT INTO public.pms_schema_migrations(id) VALUES ('202607160005_settlement_contract_snapshot') ON CONFLICT (id) DO NOTHING;
COMMIT;
