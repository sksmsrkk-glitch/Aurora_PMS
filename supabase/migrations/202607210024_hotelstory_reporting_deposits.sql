-- HotelStory-compatible deposit evidence and reporting support.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.channel_settlements
  ADD COLUMN deposit_date date,
  ADD COLUMN deposit_memo text,
  ADD COLUMN payment_journal_id text;

ALTER TABLE public.channel_settlements
  ADD CONSTRAINT channel_settlement_deposit_memo_check
    CHECK (deposit_memo IS NULL OR char_length(deposit_memo)<=500) NOT VALID,
  ADD CONSTRAINT channel_settlement_payment_journal_fk
    FOREIGN KEY(property_id,payment_journal_id)
    REFERENCES public.accounting_journal_entries(property_id,id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.channel_settlements VALIDATE CONSTRAINT channel_settlement_deposit_memo_check;
ALTER TABLE public.channel_settlements VALIDATE CONSTRAINT channel_settlement_payment_journal_fk;
CREATE INDEX channel_settlement_deposit_idx
  ON public.channel_settlements(property_id,status,deposit_date,due_date);
CREATE UNIQUE INDEX channel_settlements_property_id_uq
  ON public.channel_settlements(property_id,id);

-- Every receipt and restoration is append-only evidence. The settlement row is
-- only the current projection; accounting journals and these events retain the
-- complete financial history through repeated receipt/restore cycles.
CREATE TABLE public.channel_deposit_events (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  settlement_id text NOT NULL,
  event_type text NOT NULL,
  amount numeric(14,2) NOT NULL,
  event_date date NOT NULL,
  memo text NOT NULL DEFAULT '',
  accounting_journal_id text NOT NULL,
  reverses_event_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL,
  CONSTRAINT channel_deposit_event_property_fk FOREIGN KEY(property_id)
    REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID,
  CONSTRAINT channel_deposit_event_settlement_fk FOREIGN KEY(property_id,settlement_id)
    REFERENCES public.channel_settlements(property_id,id) ON DELETE RESTRICT NOT VALID,
  CONSTRAINT channel_deposit_event_journal_fk FOREIGN KEY(property_id,accounting_journal_id)
    REFERENCES public.accounting_journal_entries(property_id,id) ON DELETE RESTRICT NOT VALID,
  CONSTRAINT channel_deposit_event_reversal_fk FOREIGN KEY(property_id,reverses_event_id)
    REFERENCES public.channel_deposit_events(property_id,id) ON DELETE RESTRICT NOT VALID,
  CONSTRAINT channel_deposit_event_type_check CHECK (event_type IN ('RECEIPT','RESTORE')),
  CONSTRAINT channel_deposit_event_amount_check CHECK (amount>0),
  CONSTRAINT channel_deposit_event_memo_check CHECK (char_length(memo)<=500),
  CONSTRAINT channel_deposit_event_reversal_shape CHECK (
    (event_type='RECEIPT' AND reverses_event_id IS NULL) OR
    (event_type='RESTORE' AND reverses_event_id IS NOT NULL)
  ),
  CONSTRAINT channel_deposit_event_property_id_uq UNIQUE(property_id,id)
);
ALTER TABLE public.channel_deposit_events VALIDATE CONSTRAINT channel_deposit_event_property_fk;
ALTER TABLE public.channel_deposit_events VALIDATE CONSTRAINT channel_deposit_event_settlement_fk;
ALTER TABLE public.channel_deposit_events VALIDATE CONSTRAINT channel_deposit_event_journal_fk;
ALTER TABLE public.channel_deposit_events VALIDATE CONSTRAINT channel_deposit_event_reversal_fk;
CREATE INDEX channel_deposit_event_timeline_idx
  ON public.channel_deposit_events(property_id,settlement_id,created_at DESC);
CREATE UNIQUE INDEX channel_deposit_event_reversal_uq
  ON public.channel_deposit_events(property_id,reverses_event_id)
  WHERE reverses_event_id IS NOT NULL;

-- Validate the immutable event against the settlement projection while holding
-- its row lock. This turns concurrent receipt/restore requests with different
-- idempotency keys into one winner instead of two valid accounting journals.
CREATE FUNCTION public.pms_channel_deposit_event_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_status text;
  current_journal text;
  receipt_journal text;
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
    SELECT accounting_journal_id INTO receipt_journal
      FROM public.channel_deposit_events
      WHERE property_id=NEW.property_id AND id=NEW.reverses_event_id
        AND settlement_id=NEW.settlement_id AND event_type='RECEIPT';
    IF receipt_journal IS NULL OR current_status<>'PAID' OR current_journal IS DISTINCT FROM receipt_journal THEN
      RAISE EXCEPTION 'restore must reverse the current paid settlement receipt';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channel_deposit_events_validate
BEFORE INSERT ON public.channel_deposit_events
FOR EACH ROW EXECUTE FUNCTION public.pms_channel_deposit_event_guard();

CREATE TRIGGER channel_deposit_events_no_update
BEFORE UPDATE ON public.channel_deposit_events
FOR EACH ROW EXECUTE FUNCTION public.pms_immutable_guard('channel deposit events are immutable');
CREATE TRIGGER channel_deposit_events_no_delete
BEFORE DELETE ON public.channel_deposit_events
FOR EACH ROW EXECUTE FUNCTION public.pms_immutable_guard('channel deposit events are immutable');

ALTER TABLE public.channel_deposit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_deposit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY aurora_property_isolation ON public.channel_deposit_events
  FOR ALL TO aurora_app
  USING (property_id=public.pms_current_property_id())
  WITH CHECK (property_id=public.pms_current_property_id());
GRANT SELECT,INSERT ON TABLE public.channel_deposit_events TO aurora_app;
REVOKE ALL ON TABLE public.channel_deposit_events FROM anon,authenticated;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607210024_hotelstory_reporting_deposits')
ON CONFLICT(id) DO NOTHING;

COMMIT;
