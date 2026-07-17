-- Align the seeded/local PMS administrator with the production Supabase Auth login.
BEGIN;
UPDATE public.role_assignments
SET active=0
WHERE property_id='prop-seoul' AND email='frontdesk@aurora.hotel';

INSERT INTO public.role_assignments(id,property_id,email,role,active,created_at)
VALUES ('role-local-pms-admin','prop-seoul','pms@allmytour.com','PROPERTY_ADMIN',1,clock_timestamp()::text)
ON CONFLICT (property_id,email)
DO UPDATE SET role='PROPERTY_ADMIN',active=1;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607170006_default_admin_identity')
ON CONFLICT (id) DO NOTHING;
COMMIT;
