-- Historical compatibility marker.
--
-- This migration used to create a PROPERTY_ADMIN assignment for a fixed email.
-- Fresh installations must never gain an administrator through migrations or seed
-- data, so operator access is now provisioned only through scripts/provision-role.mjs.
-- The migration id is retained because deployed databases already record it.
BEGIN;
INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607170006_default_admin_identity')
ON CONFLICT (id) DO NOTHING;
COMMIT;
