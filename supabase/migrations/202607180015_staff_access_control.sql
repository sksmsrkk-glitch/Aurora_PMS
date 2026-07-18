-- Per-user hotel staff access, password-reset state, and audit-safe metadata.
BEGIN;

ALTER TABLE public.role_assignments
  ADD COLUMN IF NOT EXISTS auth_user_id uuid,
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS workspace_permissions jsonb,
  ADD COLUMN IF NOT EXISTS can_export boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_by text;

UPDATE public.role_assignments
SET display_name=CASE
      WHEN char_length(COALESCE(NULLIF(display_name,''),split_part(email,'@',1)))<2 THEN 'Staff'
      ELSE COALESCE(NULLIF(display_name,''),split_part(email,'@',1))
    END,
    workspace_permissions=COALESCE(workspace_permissions,
      CASE role
        WHEN 'PROPERTY_ADMIN' THEN '{"overview":"WRITE","frontdesk":"WRITE","inventory":"WRITE","website":"WRITE","groups":"WRITE","finance":"WRITE","accounting":"WRITE","channels":"WRITE","rooms":"WRITE","reports":"WRITE","master":"WRITE","revenue":"WRITE","users":"WRITE","audit":"WRITE"}'::jsonb
        WHEN 'NIGHT_AUDITOR' THEN '{"overview":"READ","frontdesk":"READ","inventory":"NONE","website":"NONE","groups":"NONE","finance":"WRITE","accounting":"READ","channels":"NONE","rooms":"READ","reports":"READ","master":"NONE","revenue":"NONE","users":"NONE","audit":"WRITE"}'::jsonb
        WHEN 'FRONT_DESK' THEN '{"overview":"READ","frontdesk":"WRITE","inventory":"NONE","website":"NONE","groups":"READ","finance":"WRITE","accounting":"NONE","channels":"NONE","rooms":"READ","reports":"READ","master":"NONE","revenue":"NONE","users":"NONE","audit":"NONE"}'::jsonb
        WHEN 'CASHIER' THEN '{"overview":"READ","frontdesk":"NONE","inventory":"NONE","website":"NONE","groups":"NONE","finance":"WRITE","accounting":"READ","channels":"NONE","rooms":"NONE","reports":"READ","master":"NONE","revenue":"NONE","users":"NONE","audit":"NONE"}'::jsonb
        WHEN 'HOUSEKEEPING' THEN '{"overview":"READ","frontdesk":"NONE","inventory":"NONE","website":"NONE","groups":"NONE","finance":"NONE","accounting":"NONE","channels":"NONE","rooms":"WRITE","reports":"NONE","master":"NONE","revenue":"NONE","users":"NONE","audit":"NONE"}'::jsonb
        WHEN 'REVENUE_MANAGER' THEN '{"overview":"READ","frontdesk":"NONE","inventory":"WRITE","website":"NONE","groups":"WRITE","finance":"NONE","accounting":"NONE","channels":"WRITE","rooms":"NONE","reports":"READ","master":"READ","revenue":"READ","users":"NONE","audit":"NONE"}'::jsonb
        WHEN 'SALES_MANAGER' THEN '{"overview":"READ","frontdesk":"WRITE","inventory":"NONE","website":"NONE","groups":"WRITE","finance":"NONE","accounting":"NONE","channels":"NONE","rooms":"NONE","reports":"READ","master":"NONE","revenue":"READ","users":"NONE","audit":"NONE"}'::jsonb
        WHEN 'ACCOUNTANT' THEN '{"overview":"READ","frontdesk":"NONE","inventory":"NONE","website":"NONE","groups":"NONE","finance":"WRITE","accounting":"WRITE","channels":"NONE","rooms":"NONE","reports":"READ","master":"NONE","revenue":"READ","users":"NONE","audit":"NONE"}'::jsonb
        ELSE '{"overview":"READ","frontdesk":"READ","inventory":"READ","website":"READ","groups":"READ","finance":"READ","accounting":"READ","channels":"READ","rooms":"READ","reports":"READ","master":"READ","revenue":"READ","users":"NONE","audit":"READ"}'::jsonb
      END),
    can_export=CASE WHEN role IN ('PROPERTY_ADMIN','NIGHT_AUDITOR','FRONT_DESK','CASHIER','REVENUE_MANAGER','SALES_MANAGER','ACCOUNTANT') THEN true ELSE can_export END,
    updated_at=COALESCE(updated_at,created_at,now());

-- Hosted Supabase has auth.users; plain PostgreSQL CI intentionally does not.
-- Dynamic SQL keeps the same migration portable while linking existing users when possible.
DO $link_existing_auth_users$
BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    EXECUTE 'UPDATE public.role_assignments ra SET auth_user_id=u.id FROM auth.users u WHERE ra.auth_user_id IS NULL AND lower(ra.email)=lower(u.email)';
  END IF;
END
$link_existing_auth_users$;

ALTER TABLE public.role_assignments
  ALTER COLUMN display_name SET NOT NULL,
  ALTER COLUMN workspace_permissions SET NOT NULL,
  ALTER COLUMN workspace_permissions SET DEFAULT '{"overview":"NONE","frontdesk":"NONE","inventory":"NONE","website":"NONE","groups":"NONE","finance":"NONE","accounting":"NONE","channels":"NONE","rooms":"NONE","reports":"NONE","master":"NONE","revenue":"NONE","users":"NONE","audit":"NONE"}'::jsonb,
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE public.role_assignments
  DROP CONSTRAINT IF EXISTS role_assignments_role_check,
  ADD CONSTRAINT role_assignments_role_check CHECK (role IN ('PROPERTY_ADMIN','NIGHT_AUDITOR','FRONT_DESK','CASHIER','HOUSEKEEPING','REVENUE_MANAGER','SALES_MANAGER','ACCOUNTANT','VIEWER')),
  DROP CONSTRAINT IF EXISTS role_assignments_display_name_check,
  ADD CONSTRAINT role_assignments_display_name_check CHECK (char_length(display_name) BETWEEN 2 AND 80),
  DROP CONSTRAINT IF EXISTS role_assignments_version_check,
  ADD CONSTRAINT role_assignments_version_check CHECK (version > 0),
  DROP CONSTRAINT IF EXISTS role_assignments_workspace_permissions_check,
  ADD CONSTRAINT role_assignments_workspace_permissions_check CHECK (
    jsonb_typeof(workspace_permissions)='object'
    AND workspace_permissions ?& ARRAY['overview','frontdesk','inventory','website','groups','finance','accounting','channels','rooms','reports','master','revenue','users','audit']
    AND workspace_permissions->>'overview' IN ('NONE','READ','WRITE')
    AND workspace_permissions->>'frontdesk' IN ('NONE','READ','WRITE')
    AND workspace_permissions->>'inventory' IN ('NONE','READ','WRITE')
    AND workspace_permissions->>'website' IN ('NONE','READ','WRITE')
    AND workspace_permissions->>'groups' IN ('NONE','READ','WRITE')
    AND workspace_permissions->>'finance' IN ('NONE','READ','WRITE')
    AND workspace_permissions->>'accounting' IN ('NONE','READ','WRITE')
    AND workspace_permissions->>'channels' IN ('NONE','READ','WRITE')
    AND workspace_permissions->>'rooms' IN ('NONE','READ','WRITE')
    AND workspace_permissions->>'reports' IN ('NONE','READ','WRITE')
    AND workspace_permissions->>'master' IN ('NONE','READ','WRITE')
    AND workspace_permissions->>'revenue' IN ('NONE','READ','WRITE')
    AND workspace_permissions->>'users' IN ('NONE','READ','WRITE')
    AND workspace_permissions->>'audit' IN ('NONE','READ','WRITE')
  );

CREATE INDEX IF NOT EXISTS role_assignments_auth_user_idx
  ON public.role_assignments(auth_user_id) WHERE auth_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS role_assignments_property_active_idx
  ON public.role_assignments(property_id,active,updated_at DESC);

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607180015_staff_access_control')
ON CONFLICT(id) DO NOTHING;

COMMIT;
