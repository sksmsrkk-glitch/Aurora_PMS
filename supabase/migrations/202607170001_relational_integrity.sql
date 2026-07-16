BEGIN;

-- Composite unique indexes make property_id part of every foreign-key boundary.
CREATE UNIQUE INDEX IF NOT EXISTS room_types_property_id_uq ON public.room_types(property_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS rooms_property_id_uq ON public.rooms(property_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS guests_property_id_uq ON public.guests(property_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS reservations_property_id_uq ON public.reservations(property_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS account_profiles_property_id_uq ON public.account_profiles(property_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS business_blocks_property_id_uq ON public.business_blocks(property_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS rooming_entries_property_id_uq ON public.rooming_list_entries(property_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS folio_windows_property_id_uq ON public.folio_windows(property_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS folio_entries_property_id_uq ON public.folio_entries(property_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS ar_accounts_property_id_uq ON public.ar_accounts(property_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS ar_invoices_property_id_uq ON public.ar_invoices(property_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS channel_connections_property_id_uq ON public.channel_connections(property_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS channel_mappings_property_id_uq ON public.channel_mappings(property_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS channel_contracts_property_id_uq ON public.channel_contracts(property_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS accounting_accounts_property_id_uq ON public.accounting_accounts(property_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS accounting_journals_property_id_uq ON public.accounting_journal_entries(property_id,id);

DO $$
DECLARE statement text;
BEGIN
  FOREACH statement IN ARRAY ARRAY[
    'ALTER TABLE public.room_types ADD CONSTRAINT room_types_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.rooms ADD CONSTRAINT rooms_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.rooms ADD CONSTRAINT rooms_type_fk FOREIGN KEY(property_id,room_type_id) REFERENCES public.room_types(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.guests ADD CONSTRAINT guests_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.reservations ADD CONSTRAINT reservations_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.reservations ADD CONSTRAINT reservations_guest_fk FOREIGN KEY(property_id,guest_id) REFERENCES public.guests(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.reservations ADD CONSTRAINT reservations_type_fk FOREIGN KEY(property_id,room_type_id) REFERENCES public.room_types(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.reservations ADD CONSTRAINT reservations_room_fk FOREIGN KEY(property_id,room_id) REFERENCES public.rooms(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.reservation_nights ADD CONSTRAINT reservation_nights_reservation_fk FOREIGN KEY(property_id,reservation_id) REFERENCES public.reservations(property_id,id) ON DELETE CASCADE NOT VALID',
    'ALTER TABLE public.reservation_nights ADD CONSTRAINT reservation_nights_room_fk FOREIGN KEY(property_id,room_id) REFERENCES public.rooms(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.reservation_type_nights ADD CONSTRAINT reservation_type_nights_reservation_fk FOREIGN KEY(property_id,reservation_id) REFERENCES public.reservations(property_id,id) ON DELETE CASCADE NOT VALID',
    'ALTER TABLE public.reservation_type_nights ADD CONSTRAINT reservation_type_nights_type_fk FOREIGN KEY(property_id,room_type_id) REFERENCES public.room_types(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.folio_entries ADD CONSTRAINT folio_entries_reservation_fk FOREIGN KEY(property_id,reservation_id) REFERENCES public.reservations(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.folio_entries ADD CONSTRAINT folio_entries_reversal_fk FOREIGN KEY(property_id,reverses_entry_id) REFERENCES public.folio_entries(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.housekeeping_tasks ADD CONSTRAINT housekeeping_room_fk FOREIGN KEY(property_id,room_id) REFERENCES public.rooms(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.role_assignments ADD CONSTRAINT role_assignments_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.cashier_sessions ADD CONSTRAINT cashier_sessions_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.night_audits ADD CONSTRAINT night_audits_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.reservation_transitions ADD CONSTRAINT reservation_transitions_reservation_fk FOREIGN KEY(property_id,reservation_id) REFERENCES public.reservations(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.reservation_mutations ADD CONSTRAINT reservation_mutations_reservation_fk FOREIGN KEY(property_id,reservation_id) REFERENCES public.reservations(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.inventory_controls ADD CONSTRAINT inventory_controls_type_fk FOREIGN KEY(property_id,room_type_id) REFERENCES public.room_types(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.room_moves ADD CONSTRAINT room_moves_reservation_fk FOREIGN KEY(property_id,reservation_id) REFERENCES public.reservations(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.room_moves ADD CONSTRAINT room_moves_from_room_fk FOREIGN KEY(property_id,from_room_id) REFERENCES public.rooms(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.room_moves ADD CONSTRAINT room_moves_to_room_fk FOREIGN KEY(property_id,to_room_id) REFERENCES public.rooms(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.account_profiles ADD CONSTRAINT account_profiles_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.business_blocks ADD CONSTRAINT business_blocks_account_fk FOREIGN KEY(property_id,account_profile_id) REFERENCES public.account_profiles(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.business_blocks ADD CONSTRAINT business_blocks_group_fk FOREIGN KEY(property_id,group_profile_id) REFERENCES public.account_profiles(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.block_inventory ADD CONSTRAINT block_inventory_block_fk FOREIGN KEY(property_id,block_id) REFERENCES public.business_blocks(property_id,id) ON DELETE CASCADE NOT VALID',
    'ALTER TABLE public.block_inventory ADD CONSTRAINT block_inventory_type_fk FOREIGN KEY(property_id,room_type_id) REFERENCES public.room_types(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.rooming_list_entries ADD CONSTRAINT rooming_entries_block_fk FOREIGN KEY(property_id,block_id) REFERENCES public.business_blocks(property_id,id) ON DELETE CASCADE NOT VALID',
    'ALTER TABLE public.rooming_list_entries ADD CONSTRAINT rooming_entries_type_fk FOREIGN KEY(property_id,room_type_id) REFERENCES public.room_types(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.rooming_list_entries ADD CONSTRAINT rooming_entries_reservation_fk FOREIGN KEY(property_id,reservation_id) REFERENCES public.reservations(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.block_pickup_nights ADD CONSTRAINT block_pickup_block_fk FOREIGN KEY(property_id,block_id) REFERENCES public.business_blocks(property_id,id) ON DELETE CASCADE NOT VALID',
    'ALTER TABLE public.block_pickup_nights ADD CONSTRAINT block_pickup_entry_fk FOREIGN KEY(property_id,rooming_entry_id) REFERENCES public.rooming_list_entries(property_id,id) ON DELETE CASCADE NOT VALID',
    'ALTER TABLE public.block_pickup_nights ADD CONSTRAINT block_pickup_type_fk FOREIGN KEY(property_id,room_type_id) REFERENCES public.room_types(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.folio_windows ADD CONSTRAINT folio_windows_reservation_fk FOREIGN KEY(property_id,reservation_id) REFERENCES public.reservations(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.folio_windows ADD CONSTRAINT folio_windows_payee_fk FOREIGN KEY(property_id,payee_account_profile_id) REFERENCES public.account_profiles(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.folio_entry_details ADD CONSTRAINT folio_details_entry_fk FOREIGN KEY(property_id,entry_id) REFERENCES public.folio_entries(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.folio_entry_details ADD CONSTRAINT folio_details_reservation_fk FOREIGN KEY(property_id,reservation_id) REFERENCES public.reservations(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.folio_entry_details ADD CONSTRAINT folio_details_window_fk FOREIGN KEY(property_id,folio_window_id) REFERENCES public.folio_windows(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.folio_routing_rules ADD CONSTRAINT folio_routing_reservation_fk FOREIGN KEY(property_id,reservation_id) REFERENCES public.reservations(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.folio_routing_rules ADD CONSTRAINT folio_routing_window_fk FOREIGN KEY(property_id,target_window_id) REFERENCES public.folio_windows(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.transaction_codes ADD CONSTRAINT transaction_codes_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.ar_accounts ADD CONSTRAINT ar_accounts_profile_fk FOREIGN KEY(property_id,account_profile_id) REFERENCES public.account_profiles(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.ar_invoices ADD CONSTRAINT ar_invoices_account_fk FOREIGN KEY(property_id,ar_account_id) REFERENCES public.ar_accounts(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.ar_invoices ADD CONSTRAINT ar_invoices_reservation_fk FOREIGN KEY(property_id,reservation_id) REFERENCES public.reservations(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.ar_invoices ADD CONSTRAINT ar_invoices_window_fk FOREIGN KEY(property_id,folio_window_id) REFERENCES public.folio_windows(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.ar_ledger_entries ADD CONSTRAINT ar_ledger_account_fk FOREIGN KEY(property_id,ar_account_id) REFERENCES public.ar_accounts(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.ar_ledger_entries ADD CONSTRAINT ar_ledger_invoice_fk FOREIGN KEY(property_id,invoice_id) REFERENCES public.ar_invoices(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.channel_connections ADD CONSTRAINT channel_connections_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.channel_mappings ADD CONSTRAINT channel_mappings_connection_fk FOREIGN KEY(property_id,connection_id) REFERENCES public.channel_connections(property_id,id) ON DELETE CASCADE NOT VALID',
    'ALTER TABLE public.channel_mappings ADD CONSTRAINT channel_mappings_type_fk FOREIGN KEY(property_id,room_type_id) REFERENCES public.room_types(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.channel_reservation_links ADD CONSTRAINT channel_links_connection_fk FOREIGN KEY(property_id,connection_id) REFERENCES public.channel_connections(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.channel_reservation_links ADD CONSTRAINT channel_links_reservation_fk FOREIGN KEY(property_id,reservation_id) REFERENCES public.reservations(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.inbound_channel_messages ADD CONSTRAINT inbound_messages_connection_fk FOREIGN KEY(property_id,connection_id) REFERENCES public.channel_connections(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.inbound_channel_messages ADD CONSTRAINT inbound_messages_reservation_fk FOREIGN KEY(property_id,reservation_id) REFERENCES public.reservations(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.channel_contracts ADD CONSTRAINT channel_contracts_connection_fk FOREIGN KEY(property_id,connection_id) REFERENCES public.channel_connections(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.channel_rate_overrides ADD CONSTRAINT channel_rates_connection_fk FOREIGN KEY(property_id,connection_id) REFERENCES public.channel_connections(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.channel_rate_overrides ADD CONSTRAINT channel_rates_mapping_fk FOREIGN KEY(property_id,mapping_id) REFERENCES public.channel_mappings(property_id,id) ON DELETE CASCADE NOT VALID',
    'ALTER TABLE public.channel_rate_overrides ADD CONSTRAINT channel_rates_type_fk FOREIGN KEY(property_id,room_type_id) REFERENCES public.room_types(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.channel_settlements ADD CONSTRAINT channel_settlements_contract_fk FOREIGN KEY(property_id,contract_id) REFERENCES public.channel_contracts(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.channel_settlements ADD CONSTRAINT channel_settlements_connection_fk FOREIGN KEY(property_id,connection_id) REFERENCES public.channel_connections(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.channel_settlements ADD CONSTRAINT channel_settlements_reservation_fk FOREIGN KEY(property_id,reservation_id) REFERENCES public.reservations(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.accounting_accounts ADD CONSTRAINT accounting_accounts_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.accounting_journal_entries ADD CONSTRAINT accounting_journals_property_fk FOREIGN KEY(property_id) REFERENCES public.properties(id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.accounting_journal_entries ADD CONSTRAINT accounting_journals_reversal_fk FOREIGN KEY(property_id,reversal_of_id) REFERENCES public.accounting_journal_entries(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.accounting_journal_lines ADD CONSTRAINT accounting_lines_journal_fk FOREIGN KEY(property_id,journal_entry_id) REFERENCES public.accounting_journal_entries(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.accounting_journal_lines ADD CONSTRAINT accounting_lines_account_fk FOREIGN KEY(property_id,account_id) REFERENCES public.accounting_accounts(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.accounting_journal_lines ADD CONSTRAINT accounting_lines_channel_fk FOREIGN KEY(property_id,channel_connection_id) REFERENCES public.channel_connections(property_id,id) ON DELETE RESTRICT NOT VALID',
    'ALTER TABLE public.accounting_journal_lines ADD CONSTRAINT accounting_lines_reservation_fk FOREIGN KEY(property_id,reservation_id) REFERENCES public.reservations(property_id,id) ON DELETE RESTRICT NOT VALID'
  ] LOOP
    BEGIN EXECUTE statement; EXCEPTION WHEN duplicate_object THEN NULL; END;
  END LOOP;
END $$;

-- Exactly one reversal and one externally sourced journal may exist.
CREATE UNIQUE INDEX IF NOT EXISTS accounting_journal_reversal_once_uq
  ON public.accounting_journal_entries(property_id,reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounting_journal_source_once_uq
  ON public.accounting_journal_entries(property_id,source_type,source_id)
  WHERE source_id IS NOT NULL AND source_type IN ('CHANNEL_ACCRUAL','CHANNEL_PAYMENT','JOURNAL_REVERSAL');

-- Existing data was audited before this migration; validation turns NOT VALID
-- constraints into fully enforced and planner-visible constraints.
DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT conrelid::regclass table_name, conname
    FROM pg_constraint
    WHERE connamespace='public'::regnamespace AND contype='f' AND NOT convalidated
  LOOP
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I',item.table_name,item.conname);
  END LOOP;
END $$;

INSERT INTO public.pms_schema_migrations(id) VALUES ('202607170001_relational_integrity') ON CONFLICT (id) DO NOTHING;
COMMIT;
