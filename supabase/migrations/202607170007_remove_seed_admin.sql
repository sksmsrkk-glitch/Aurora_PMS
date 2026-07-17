-- Runtime and seed data must never confer an administrator role. Existing operator-
-- provisioned assignments use their own id; this removes only the historical seed id.
BEGIN;
DELETE FROM public.role_assignments
WHERE id IN ('role-local-admin','role-local-pms-admin');

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607170007_remove_seed_admin')
ON CONFLICT (id) DO NOTHING;
COMMIT;
