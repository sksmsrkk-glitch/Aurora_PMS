-- Transaction-local tenant context and a non-bypass application role.
BEGIN;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aurora_app') THEN
    CREATE ROLE aurora_app
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE aurora_app
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$role$;

GRANT aurora_app TO postgres;
GRANT USAGE ON SCHEMA public TO aurora_app;

CREATE OR REPLACE FUNCTION public.pms_current_property_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  SELECT NULLIF(current_setting('app.property_id', true), '')
$function$;

REVOKE ALL ON FUNCTION public.pms_current_property_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pms_current_property_id() TO aurora_app;

-- Idempotency keys are tenant-owned. The previous global primary key made the
-- same client-generated key collide across unrelated properties.
ALTER TABLE public.idempotency_keys
  DROP CONSTRAINT IF EXISTS idempotency_keys_pkey;
ALTER TABLE public.idempotency_keys
  ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY(property_id, key);

DO $policies$
DECLARE
  tenant_table text;
  tenant_column text;
  tables text[] := ARRAY[
    'properties','room_types','rooms','guests','reservations',
    'reservation_nights','reservation_type_nights','reservation_rate_nights',
    'booking_requests','folio_entries','folio_entry_details','folio_windows',
    'folio_routing_rules','transaction_codes','housekeeping_tasks','audit_logs',
    'outbox_events','idempotency_keys','cashier_sessions','night_audits',
    'reservation_transitions','reservation_mutations','inventory_controls',
    'room_moves','account_profiles','business_blocks','block_inventory',
    'block_pickup_nights','rooming_list_entries','ar_accounts','ar_invoices',
    'ar_ledger_entries','channel_connections','channel_mappings','ari_updates',
    'channel_reservation_links','inbound_channel_messages',
    'integration_delivery_attempts','report_exports','channel_contracts',
    'channel_rate_overrides','channel_settlements','accounting_accounts',
    'accounting_journal_entries','accounting_journal_lines','website_settings',
    'room_type_website','website_media','role_assignments'
  ];
BEGIN
  FOREACH tenant_table IN ARRAY tables LOOP
    tenant_column := CASE WHEN tenant_table = 'properties' THEN 'id' ELSE 'property_id' END;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('DROP POLICY IF EXISTS aurora_property_isolation ON public.%I', tenant_table);
    EXECUTE format(
      'CREATE POLICY aurora_property_isolation ON public.%I FOR ALL TO aurora_app USING (%I = public.pms_current_property_id()) WITH CHECK (%I = public.pms_current_property_id())',
      tenant_table,
      tenant_column,
      tenant_column
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO aurora_app', tenant_table);
  END LOOP;
END
$policies$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aurora_app;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607170010_tenant_context_rls')
ON CONFLICT (id) DO NOTHING;
COMMIT;
