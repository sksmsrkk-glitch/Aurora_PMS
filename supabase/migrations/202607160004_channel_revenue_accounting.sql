BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- A channel has one current commercial contract. Historical settlements retain
-- the contract snapshot amounts, so later contract edits never rewrite history.
CREATE TABLE IF NOT EXISTS public.channel_contracts (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  connection_id text NOT NULL,
  contract_type text NOT NULL CHECK (contract_type IN ('COMMISSION','NET_RATE')),
  commission_percent numeric(7,4) NOT NULL DEFAULT 0 CHECK (commission_percent >= 0 AND commission_percent <= 100),
  settlement_cycle text NOT NULL DEFAULT 'PER_STAY' CHECK (settlement_cycle IN ('PER_STAY','WEEKLY','MONTHLY')),
  payment_terms_days integer NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365),
  currency text NOT NULL DEFAULT 'KRW',
  valid_from text NOT NULL,
  valid_to text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  version integer NOT NULL DEFAULT 1,
  created_at text NOT NULL,
  created_by text NOT NULL,
  updated_at text NOT NULL,
  updated_by text NOT NULL,
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK ((contract_type='COMMISSION' AND commission_percent > 0) OR (contract_type='NET_RATE' AND commission_percent = 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_contract_connection_uq ON public.channel_contracts(connection_id);
CREATE INDEX IF NOT EXISTS channel_contract_property_status_idx ON public.channel_contracts(property_id,status,valid_from);

-- Per mapping and stay date: consumer-facing sell rate and the amount remitted
-- to the hotel. For commission contracts hotel_net is derived at settlement;
-- net-rate contracts require an explicit net rate.
CREATE TABLE IF NOT EXISTS public.channel_rate_overrides (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  connection_id text NOT NULL,
  mapping_id text NOT NULL,
  room_type_id text NOT NULL,
  stay_date text NOT NULL,
  sell_rate numeric(14,2) NOT NULL CHECK (sell_rate >= 0),
  net_rate numeric(14,2) CHECK (net_rate IS NULL OR (net_rate >= 0 AND net_rate <= sell_rate)),
  currency text NOT NULL DEFAULT 'KRW',
  version integer NOT NULL DEFAULT 1,
  updated_at text NOT NULL,
  updated_by text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_rate_mapping_date_uq ON public.channel_rate_overrides(mapping_id,stay_date);
CREATE INDEX IF NOT EXISTS channel_rate_calendar_idx ON public.channel_rate_overrides(property_id,room_type_id,stay_date);

CREATE TABLE IF NOT EXISTS public.channel_settlements (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  contract_id text NOT NULL,
  connection_id text NOT NULL,
  reservation_id text,
  business_date text NOT NULL,
  contract_type text NOT NULL CHECK (contract_type IN ('COMMISSION','NET_RATE')),
  commission_percent numeric(7,4) NOT NULL DEFAULT 0 CHECK (commission_percent >= 0 AND commission_percent <= 100),
  gross_sell_amount numeric(14,2) NOT NULL CHECK (gross_sell_amount >= 0),
  channel_cost_amount numeric(14,2) NOT NULL CHECK (channel_cost_amount >= 0),
  hotel_net_amount numeric(14,2) NOT NULL CHECK (hotel_net_amount >= 0),
  currency text NOT NULL DEFAULT 'KRW',
  due_date text NOT NULL,
  status text NOT NULL DEFAULT 'ACCRUED' CHECK (status IN ('ACCRUED','PAID','HELD','VOID')),
  paid_at text,
  created_at text NOT NULL,
  created_by text NOT NULL,
  updated_at text NOT NULL,
  updated_by text NOT NULL,
  CHECK (abs((gross_sell_amount - channel_cost_amount) - hotel_net_amount) <= 0.01)
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_settlement_reservation_uq ON public.channel_settlements(connection_id,reservation_id) WHERE reservation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS channel_settlement_due_idx ON public.channel_settlements(property_id,status,due_date);

-- Hotel chart of accounts and append-only double-entry journal.
CREATE TABLE IF NOT EXISTS public.accounting_accounts (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  category text NOT NULL,
  department text,
  external_code text,
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  version integer NOT NULL DEFAULT 1,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS accounting_account_code_uq ON public.accounting_accounts(property_id,code);
CREATE INDEX IF NOT EXISTS accounting_account_type_idx ON public.accounting_accounts(property_id,account_type,active);

CREATE TABLE IF NOT EXISTS public.accounting_journal_entries (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  entry_no text NOT NULL,
  business_date text NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('REVENUE','EXPENSE','ADJUSTMENT','CHANNEL_SETTLEMENT','REVERSAL')),
  source_type text NOT NULL,
  source_id text,
  description text NOT NULL,
  vendor text,
  status text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','REVERSED')),
  reversal_of_id text,
  created_at text NOT NULL,
  created_by text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS accounting_journal_no_uq ON public.accounting_journal_entries(property_id,entry_no);
CREATE INDEX IF NOT EXISTS accounting_journal_date_idx ON public.accounting_journal_entries(property_id,business_date,entry_type);

CREATE TABLE IF NOT EXISTS public.accounting_journal_lines (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  journal_entry_id text NOT NULL,
  account_id text NOT NULL,
  debit numeric(14,2) NOT NULL DEFAULT 0,
  credit numeric(14,2) NOT NULL DEFAULT 0,
  department text,
  channel_connection_id text,
  reservation_id text,
  memo text,
  created_at text NOT NULL,
  CHECK (debit >= 0 AND credit >= 0),
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);
CREATE INDEX IF NOT EXISTS accounting_journal_line_entry_idx ON public.accounting_journal_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS accounting_journal_line_account_idx ON public.accounting_journal_lines(property_id,account_id,created_at);

CREATE OR REPLACE FUNCTION public.pms_accounting_line_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.accounting_accounts a WHERE a.id=NEW.account_id AND a.property_id=NEW.property_id AND a.active=1) THEN
    RAISE EXCEPTION 'active accounting account is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries e WHERE e.id=NEW.journal_entry_id AND e.property_id=NEW.property_id AND e.status='POSTED') THEN
    RAISE EXCEPTION 'posted journal entry is required';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS accounting_journal_lines_validate_insert ON public.accounting_journal_lines;
CREATE TRIGGER accounting_journal_lines_validate_insert BEFORE INSERT ON public.accounting_journal_lines FOR EACH ROW EXECUTE FUNCTION public.pms_accounting_line_guard();
DROP TRIGGER IF EXISTS accounting_journal_lines_no_update ON public.accounting_journal_lines;
CREATE TRIGGER accounting_journal_lines_no_update BEFORE UPDATE ON public.accounting_journal_lines FOR EACH ROW EXECUTE FUNCTION public.pms_immutable_guard('accounting journal lines are immutable');
DROP TRIGGER IF EXISTS accounting_journal_lines_no_delete ON public.accounting_journal_lines;
CREATE TRIGGER accounting_journal_lines_no_delete BEFORE DELETE ON public.accounting_journal_lines FOR EACH ROW EXECUTE FUNCTION public.pms_immutable_guard('accounting journal lines are immutable');

CREATE OR REPLACE FUNCTION public.pms_accounting_header_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='POSTED' AND NEW.status='REVERSED'
     AND OLD.id=NEW.id AND OLD.property_id=NEW.property_id AND OLD.entry_no=NEW.entry_no
     AND OLD.business_date=NEW.business_date AND OLD.entry_type=NEW.entry_type
     AND OLD.source_type=NEW.source_type AND OLD.description=NEW.description
     AND OLD.created_at=NEW.created_at AND OLD.created_by=NEW.created_by THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'posted accounting entries are immutable; create a reversal';
END;
$$;
DROP TRIGGER IF EXISTS accounting_journal_entries_guard_update ON public.accounting_journal_entries;
CREATE TRIGGER accounting_journal_entries_guard_update BEFORE UPDATE ON public.accounting_journal_entries FOR EACH ROW EXECUTE FUNCTION public.pms_accounting_header_guard();
DROP TRIGGER IF EXISTS accounting_journal_entries_no_delete ON public.accounting_journal_entries;
CREATE TRIGGER accounting_journal_entries_no_delete BEFORE DELETE ON public.accounting_journal_entries FOR EACH ROW EXECUTE FUNCTION public.pms_immutable_guard('accounting journal entries are immutable');

ALTER TABLE public.channel_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_rate_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_journal_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.channel_contracts, public.channel_rate_overrides, public.channel_settlements, public.accounting_accounts, public.accounting_journal_entries, public.accounting_journal_lines FROM anon, authenticated;

INSERT INTO public.accounting_accounts(id,property_id,code,name,account_type,category,department,created_at,updated_at)
SELECT 'acct-'||p.id||'-'||v.code,p.id,v.code,v.name,v.account_type,v.category,v.department,clock_timestamp()::text,clock_timestamp()::text
FROM public.properties p
CROSS JOIN (VALUES
  ('1100','현금 및 예금','ASSET','CASH','FINANCE'),
  ('1200','채널 미수금','ASSET','CHANNEL_RECEIVABLE','FINANCE'),
  ('1300','매출채권','ASSET','ACCOUNTS_RECEIVABLE','FINANCE'),
  ('2100','매입채무','LIABILITY','ACCOUNTS_PAYABLE','FINANCE'),
  ('2200','채널 수수료 미지급금','LIABILITY','CHANNEL_COMMISSION_PAYABLE','FINANCE'),
  ('2300','부가세 예수금','LIABILITY','TAX_PAYABLE','FINANCE'),
  ('4100','객실 매출','REVENUE','ROOM_REVENUE','ROOMS'),
  ('4200','기타 영업 매출','REVENUE','OTHER_REVENUE','OPERATIONS'),
  ('5100','채널 유통 비용','EXPENSE','CHANNEL_DISTRIBUTION','SALES'),
  ('5200','호텔 운영 비용','EXPENSE','OPERATING_EXPENSE','OPERATIONS'),
  ('5990','조정 손익','EXPENSE','ADJUSTMENT','FINANCE')
) AS v(code,name,account_type,category,department)
ON CONFLICT (property_id,code) DO NOTHING;

INSERT INTO public.pms_schema_migrations(id) VALUES ('202607160004_channel_revenue_accounting') ON CONFLICT (id) DO NOTHING;
COMMIT;
