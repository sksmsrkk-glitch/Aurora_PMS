BEGIN;
ALTER TABLE public.pms_schema_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pms_schema_migrations FROM anon, authenticated;
INSERT INTO pms_schema_migrations(id) VALUES ('202607160003_lock_migration_history') ON CONFLICT (id) DO NOTHING;
COMMIT;
