-- Multi-hotel SaaS control plane, tenant lifecycle, support, migration and worker foundations.
BEGIN;

CREATE TABLE public.organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT organizations_slug_check CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  CONSTRAINT organizations_status_check CHECK (status IN ('TRIAL','ACTIVE','SUSPENDED','OFFBOARDING','CLOSED'))
);

CREATE TABLE public.organization_memberships (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  auth_user_id uuid NOT NULL,
  email text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT organization_membership_role_check CHECK (role IN ('OWNER','ADMIN','ANALYST')),
  CONSTRAINT organization_membership_email_check CHECK (email=lower(email) AND char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT organization_membership_name_check CHECK (char_length(display_name) BETWEEN 2 AND 80),
  CONSTRAINT organization_membership_user_uq UNIQUE(organization_id,auth_user_id)
);
CREATE INDEX organization_memberships_user_idx ON public.organization_memberships(auth_user_id) WHERE active;

CREATE TABLE public.platform_operators (
  auth_user_id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  role text NOT NULL DEFAULT 'SUPPORT',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT platform_operator_role_check CHECK (role IN ('SUPPORT','SUPPORT_ADMIN','SECURITY_ADMIN')),
  CONSTRAINT platform_operator_email_check CHECK (email=lower(email) AND char_length(email) BETWEEN 3 AND 254)
);

-- Existing hotels remain isolated: each receives its own organization unless an
-- operator explicitly consolidates them later through a reviewed migration.
INSERT INTO public.organizations(id,name,slug,status)
SELECT 'org-'||p.id,p.name,
       trim(both '-' from lower(regexp_replace(p.id,'[^a-zA-Z0-9]+','-','g'))),
       'ACTIVE'
FROM public.properties p
ON CONFLICT(id) DO NOTHING;

ALTER TABLE public.properties
  ADD COLUMN organization_id text,
  ADD COLUMN slug text,
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN onboarding_status text NOT NULL DEFAULT 'LIVE',
  ADD COLUMN plan_code text NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN cell_key text NOT NULL DEFAULT 'primary',
  ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

UPDATE public.properties
SET organization_id=COALESCE(organization_id,'org-'||id),
    slug=COALESCE(slug,trim(both '-' from lower(regexp_replace(code,'[^a-zA-Z0-9]+','-','g'))));

ALTER TABLE public.properties
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN slug SET NOT NULL,
  ADD CONSTRAINT properties_organization_fk FOREIGN KEY(organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT,
  ADD CONSTRAINT properties_slug_check CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  ADD CONSTRAINT properties_status_check CHECK (status IN ('TRIAL','ACTIVE','SUSPENDED','OFFBOARDING','CLOSED')),
  ADD CONSTRAINT properties_onboarding_check CHECK (onboarding_status IN ('DRAFT','PROVISIONING','CONFIGURING','MIGRATING','READY','LIVE','FAILED')),
  ADD CONSTRAINT properties_cell_check CHECK (cell_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT properties_settings_object CHECK (jsonb_typeof(settings)='object'),
  ADD CONSTRAINT properties_org_id_uq UNIQUE(organization_id,id),
  ADD CONSTRAINT properties_slug_uq UNIQUE(slug);
CREATE INDEX properties_organization_status_idx ON public.properties(organization_id,status,name);

INSERT INTO public.organization_memberships(
  id,organization_id,auth_user_id,email,display_name,role,active,created_at,updated_at
)
SELECT 'org-member-'||ra.id,p.organization_id,ra.auth_user_id,lower(ra.email),ra.display_name,'OWNER',true,
       COALESCE(ra.created_at,clock_timestamp()),COALESCE(ra.updated_at,clock_timestamp())
FROM public.role_assignments ra
JOIN public.properties p ON p.id=ra.property_id
WHERE ra.role='PROPERTY_ADMIN' AND ra.active AND ra.auth_user_id IS NOT NULL
ON CONFLICT(organization_id,auth_user_id) DO NOTHING;

CREATE TABLE public.property_domains (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  hostname text NOT NULL,
  kind text NOT NULL DEFAULT 'SUBDOMAIN',
  status text NOT NULL DEFAULT 'PENDING',
  is_primary boolean NOT NULL DEFAULT false,
  verification_token_hash text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT property_domain_hostname_check CHECK (hostname=lower(hostname) AND hostname ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  CONSTRAINT property_domain_kind_check CHECK (kind IN ('PLATFORM','SUBDOMAIN','CUSTOM')),
  CONSTRAINT property_domain_status_check CHECK (status IN ('PENDING','VERIFYING','ACTIVE','FAILED','DISABLED')),
  CONSTRAINT property_domain_hostname_uq UNIQUE(hostname)
);
CREATE UNIQUE INDEX property_domain_primary_uq ON public.property_domains(property_id) WHERE is_primary AND status='ACTIVE';
CREATE INDEX property_domain_property_idx ON public.property_domains(property_id,status,hostname);

CREATE TABLE public.property_subscriptions (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  plan_code text NOT NULL,
  status text NOT NULL DEFAULT 'TRIALING',
  room_limit integer,
  user_limit integer,
  trial_ends_at timestamptz,
  current_period_start date NOT NULL,
  current_period_end date NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT property_subscription_status_check CHECK (status IN ('TRIALING','ACTIVE','PAST_DUE','SUSPENDED','CANCELLED')),
  CONSTRAINT property_subscription_period_check CHECK (current_period_end>=current_period_start),
  CONSTRAINT property_subscription_limits_check CHECK ((room_limit IS NULL OR room_limit>0) AND (user_limit IS NULL OR user_limit>0)),
  CONSTRAINT property_subscription_version_check CHECK (version>0),
  CONSTRAINT property_subscription_property_uq UNIQUE(property_id)
);

CREATE TABLE public.property_entitlements (
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  PRIMARY KEY(property_id,feature_key),
  CONSTRAINT property_entitlement_key_check CHECK (feature_key ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT property_entitlement_limits_object CHECK (jsonb_typeof(limits)='object')
);

CREATE TABLE public.support_access_grants (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  operator_user_id uuid NOT NULL REFERENCES public.platform_operators(auth_user_id) ON DELETE RESTRICT,
  operator_email text NOT NULL,
  access_mode text NOT NULL DEFAULT 'READ',
  workspace_permissions jsonb NOT NULL,
  pii_mode text NOT NULL DEFAULT 'MASKED',
  reason text NOT NULL,
  ticket_reference text NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revoked_by text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT support_grant_mode_check CHECK (access_mode IN ('READ','WRITE')),
  CONSTRAINT support_grant_pii_check CHECK (pii_mode IN ('MASKED','FULL')),
  CONSTRAINT support_grant_window_check CHECK (expires_at>starts_at AND expires_at<=starts_at+interval '8 hours'),
  CONSTRAINT support_grant_permissions_object CHECK (jsonb_typeof(workspace_permissions)='object'),
  CONSTRAINT support_grant_reason_check CHECK (char_length(reason) BETWEEN 10 AND 1000),
  CONSTRAINT support_grant_ticket_check CHECK (char_length(ticket_reference) BETWEEN 3 AND 80)
);
CREATE INDEX support_grant_active_idx ON public.support_access_grants(property_id,operator_user_id,expires_at) WHERE revoked_at IS NULL;

CREATE TABLE public.support_sessions (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  grant_id text NOT NULL REFERENCES public.support_access_grants(id) ON DELETE RESTRICT,
  operator_user_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  request_count integer NOT NULL DEFAULT 0,
  write_count integer NOT NULL DEFAULT 0,
  CONSTRAINT support_session_counts_check CHECK (request_count>=0 AND write_count>=0)
);
CREATE INDEX support_session_active_idx ON public.support_sessions(property_id,operator_user_id,last_seen_at DESC) WHERE ended_at IS NULL;

CREATE TABLE public.data_import_jobs (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  kind text NOT NULL,
  mode text NOT NULL DEFAULT 'DRY_RUN',
  status text NOT NULL DEFAULT 'VALIDATING',
  source_name text NOT NULL,
  content_hash text NOT NULL,
  row_count integer NOT NULL DEFAULT 0,
  valid_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL,
  committed_at timestamptz,
  rolled_back_at timestamptz,
  CONSTRAINT import_job_kind_check CHECK (kind IN ('ROOM_TYPES','ROOMS','GUESTS','RESERVATIONS')),
  CONSTRAINT import_job_mode_check CHECK (mode IN ('DRY_RUN','COMMIT')),
  CONSTRAINT import_job_status_check CHECK (status IN ('VALIDATING','VALIDATED','COMMITTING','COMPLETED','FAILED','ROLLED_BACK')),
  CONSTRAINT import_job_counts_check CHECK (row_count>=0 AND valid_count>=0 AND error_count>=0 AND valid_count+error_count<=row_count),
  CONSTRAINT import_job_summary_object CHECK (jsonb_typeof(summary)='object'),
  CONSTRAINT import_job_hash_uq UNIQUE(property_id,kind,content_hash,mode)
);
CREATE INDEX import_job_recent_idx ON public.data_import_jobs(property_id,created_at DESC);

CREATE TABLE public.data_import_rows (
  job_id text NOT NULL REFERENCES public.data_import_jobs(id) ON DELETE CASCADE,
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  normalized_data jsonb NOT NULL,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY(job_id,row_number),
  CONSTRAINT import_row_number_check CHECK (row_number>0),
  CONSTRAINT import_row_data_object CHECK (jsonb_typeof(normalized_data)='object'),
  CONSTRAINT import_row_errors_array CHECK (jsonb_typeof(validation_errors)='array')
);

CREATE TABLE public.data_import_entities (
  job_id text NOT NULL REFERENCES public.data_import_jobs(id) ON DELETE CASCADE,
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  source_key text NOT NULL,
  entity_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(job_id,entity_type,entity_id),
  CONSTRAINT import_entity_type_check CHECK (entity_type IN ('ROOM_TYPE','ROOM','GUEST','RESERVATION'))
);
CREATE UNIQUE INDEX import_entity_source_uq ON public.data_import_entities(job_id,entity_type,source_key);
CREATE INDEX import_entity_mapping_idx ON public.data_import_entities(property_id,entity_type,source_key,created_at DESC);

CREATE TABLE public.worker_jobs (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  source_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'PENDING',
  priority integer NOT NULL DEFAULT 100,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_at timestamptz,
  locked_by text,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT worker_job_type_check CHECK (job_type IN ('OUTBOX_WEBHOOK','ARI_DELIVERY','BACKUP_VERIFY','DOMAIN_VERIFY','USAGE_ROLLUP')),
  CONSTRAINT worker_job_status_check CHECK (status IN ('PENDING','RUNNING','RETRY','SUCCEEDED','DEAD')),
  CONSTRAINT worker_job_attempts_check CHECK (attempts>=0 AND max_attempts BETWEEN 1 AND 25 AND attempts<=max_attempts),
  CONSTRAINT worker_job_payload_object CHECK (jsonb_typeof(payload)='object'),
  CONSTRAINT worker_job_source_uq UNIQUE(property_id,job_type,source_id)
);
CREATE INDEX worker_job_claim_idx ON public.worker_jobs(status,available_at,priority,created_at) WHERE status IN ('PENDING','RETRY');

CREATE TABLE public.worker_attempts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  job_id text NOT NULL REFERENCES public.worker_jobs(id) ON DELETE CASCADE,
  attempt_no integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  outcome text,
  http_status integer,
  duration_ms integer,
  error_code text,
  CONSTRAINT worker_attempt_number_check CHECK (attempt_no>0),
  CONSTRAINT worker_attempt_outcome_check CHECK (outcome IS NULL OR outcome IN ('SUCCEEDED','RETRY','DEAD')),
  CONSTRAINT worker_attempt_duration_check CHECK (duration_ms IS NULL OR duration_ms>=0),
  CONSTRAINT worker_attempt_job_uq UNIQUE(job_id,attempt_no)
);

CREATE TABLE public.property_webhooks (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  name text NOT NULL,
  endpoint_url text NOT NULL,
  secret_reference text NOT NULL,
  event_types jsonb NOT NULL DEFAULT '["*"]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT property_webhook_https_check CHECK (endpoint_url ~ '^https://'),
  CONSTRAINT property_webhook_secret_check CHECK (secret_reference ~ '^AURORA_WEBHOOK_SECRET_[A-Z0-9_]{4,80}$'),
  CONSTRAINT property_webhook_events_array CHECK (jsonb_typeof(event_types)='array')
);
CREATE INDEX property_webhook_active_idx ON public.property_webhooks(property_id,active);

CREATE TABLE public.backup_runs (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  backup_type text NOT NULL,
  status text NOT NULL DEFAULT 'REQUESTED',
  storage_reference text,
  checksum text,
  size_bytes bigint,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  verified_at timestamptz,
  requested_by text NOT NULL,
  error_message text,
  CONSTRAINT backup_type_check CHECK (backup_type IN ('DATABASE_SNAPSHOT','PROPERTY_EXPORT','RESTORE_REHEARSAL')),
  CONSTRAINT backup_status_check CHECK (status IN ('REQUESTED','RUNNING','COMPLETED','VERIFIED','FAILED')),
  CONSTRAINT backup_size_check CHECK (size_bytes IS NULL OR size_bytes>=0)
);
CREATE INDEX backup_run_recent_idx ON public.backup_runs(property_id,requested_at DESC);

CREATE TABLE public.service_incidents (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  component text NOT NULL,
  severity text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  summary text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT incident_severity_check CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  CONSTRAINT incident_status_check CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  CONSTRAINT incident_metadata_object CHECK (jsonb_typeof(metadata)='object')
);
CREATE INDEX incident_open_idx ON public.service_incidents(property_id,severity,started_at DESC) WHERE status<>'RESOLVED';

CREATE TABLE public.property_usage_daily (
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  active_rooms integer NOT NULL DEFAULT 0,
  active_users integer NOT NULL DEFAULT 0,
  reservations_created integer NOT NULL DEFAULT 0,
  api_requests bigint NOT NULL DEFAULT 0,
  report_exports integer NOT NULL DEFAULT 0,
  storage_bytes bigint NOT NULL DEFAULT 0,
  calculated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(property_id,usage_date),
  CONSTRAINT property_usage_nonnegative_check CHECK (
    active_rooms>=0 AND active_users>=0 AND reservations_created>=0 AND api_requests>=0 AND report_exports>=0 AND storage_bytes>=0
  )
);

-- Every existing hotel starts with an explicit subscription and capabilities.
INSERT INTO public.property_subscriptions(
  id,property_id,plan_code,status,current_period_start,current_period_end
)
SELECT 'subscription-'||p.id,p.id,p.plan_code,'ACTIVE',p.business_date,
       (p.business_date+interval '1 month'-interval '1 day')::date
FROM public.properties p
ON CONFLICT(property_id) DO NOTHING;

INSERT INTO public.property_entitlements(property_id,feature_key,enabled,limits,updated_by)
SELECT p.id,feature,true,'{}'::jsonb,'system:migration'
FROM public.properties p
CROSS JOIN unnest(ARRAY[
  'CORE_PMS','DIRECT_BOOKING','WEBSITE_CMS','REPORT_EXPORT','ACCOUNTING',
  'CHANNEL_HUB','GROUP_SALES','STAFF_ACCESS','DATA_IMPORT','SUPPORT_ACCESS'
]) feature
ON CONFLICT(property_id,feature_key) DO NOTHING;

-- Preserve the existing production aliases as trusted public domains for the
-- initial hotel. New hotels receive their hostname during atomic provisioning.
INSERT INTO public.property_domains(id,property_id,hostname,kind,status,is_primary,verified_at)
SELECT 'domain-'||p.id||'-platform',p.id,'aurora-pms-gilt.vercel.app','PLATFORM','ACTIVE',true,clock_timestamp()
FROM public.properties p WHERE p.id='prop-seoul'
ON CONFLICT(hostname) DO NOTHING;

-- Outbox and ARI writes atomically enqueue delivery work. The unique source key
-- makes trigger retries converge on one job without coupling the core commit to
-- an external network call.
CREATE OR REPLACE FUNCTION public.aurora_enqueue_outbox_job()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.status IN ('PENDING','FAILED') THEN
    INSERT INTO public.worker_jobs(id,property_id,job_type,source_id,payload,status,priority,available_at)
    VALUES ('job-outbox-'||NEW.id,NEW.property_id,'OUTBOX_WEBHOOK',NEW.id,
            jsonb_build_object('topic',NEW.topic,'aggregateType',NEW.aggregate_type,'aggregateId',NEW.aggregate_id),
            'PENDING',50,clock_timestamp())
    ON CONFLICT(property_id,job_type,source_id) DO UPDATE
      SET status=CASE WHEN public.worker_jobs.status='SUCCEEDED' THEN public.worker_jobs.status ELSE 'RETRY' END,
          available_at=clock_timestamp(),updated_at=clock_timestamp();
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS aurora_outbox_worker_trigger ON public.outbox_events;
CREATE TRIGGER aurora_outbox_worker_trigger
AFTER INSERT OR UPDATE OF status ON public.outbox_events
FOR EACH ROW EXECUTE FUNCTION public.aurora_enqueue_outbox_job();

CREATE OR REPLACE FUNCTION public.aurora_enqueue_ari_job()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.status IN ('PENDING','FAILED') THEN
    INSERT INTO public.worker_jobs(id,property_id,job_type,source_id,payload,status,priority,available_at)
    VALUES ('job-ari-'||NEW.id,NEW.property_id,'ARI_DELIVERY',NEW.id,
            jsonb_build_object('connectionId',NEW.connection_id,'mappingId',NEW.mapping_id,'stayDate',NEW.stay_date,'revision',NEW.revision),
            'PENDING',25,clock_timestamp())
    ON CONFLICT(property_id,job_type,source_id) DO UPDATE
      SET status=CASE WHEN public.worker_jobs.status='SUCCEEDED' THEN public.worker_jobs.status ELSE 'RETRY' END,
          available_at=clock_timestamp(),updated_at=clock_timestamp();
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS aurora_ari_worker_trigger ON public.ari_updates;
CREATE TRIGGER aurora_ari_worker_trigger
AFTER INSERT OR UPDATE OF status ON public.ari_updates
FOR EACH ROW EXECUTE FUNCTION public.aurora_enqueue_ari_job();

-- Plan limits are enforced inside the database and serialized by locking the
-- subscription row. Application prechecks improve UX, while these triggers
-- close the concurrent-request race and cover imports or future API paths.
CREATE OR REPLACE FUNCTION public.aurora_enforce_room_limit()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE plan_limit integer; used_count integer;
BEGIN
  IF NOT NEW.active OR (TG_OP='UPDATE' AND OLD.active AND NEW.active) THEN RETURN NEW; END IF;
  SELECT room_limit INTO plan_limit FROM public.property_subscriptions WHERE property_id=NEW.property_id FOR UPDATE;
  IF plan_limit IS NULL THEN RETURN NEW; END IF;
  SELECT count(*) INTO used_count FROM public.rooms WHERE property_id=NEW.property_id AND active AND id<>NEW.id;
  IF used_count>=plan_limit THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SUBSCRIPTION_ROOM_LIMIT_EXCEEDED'; END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS aurora_room_limit_trigger ON public.rooms;
CREATE TRIGGER aurora_room_limit_trigger BEFORE INSERT OR UPDATE OF active ON public.rooms
FOR EACH ROW EXECUTE FUNCTION public.aurora_enforce_room_limit();

CREATE OR REPLACE FUNCTION public.aurora_enforce_user_limit()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE plan_limit integer; used_count integer;
BEGIN
  IF NOT NEW.active OR (TG_OP='UPDATE' AND OLD.active AND NEW.active) THEN RETURN NEW; END IF;
  SELECT user_limit INTO plan_limit FROM public.property_subscriptions WHERE property_id=NEW.property_id FOR UPDATE;
  IF plan_limit IS NULL THEN RETURN NEW; END IF;
  SELECT count(*) INTO used_count FROM public.role_assignments WHERE property_id=NEW.property_id AND active AND id<>NEW.id;
  IF used_count>=plan_limit THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SUBSCRIPTION_USER_LIMIT_EXCEEDED'; END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS aurora_user_limit_trigger ON public.role_assignments;
CREATE TRIGGER aurora_user_limit_trigger BEFORE INSERT OR UPDATE OF active ON public.role_assignments
FOR EACH ROW EXECUTE FUNCTION public.aurora_enforce_user_limit();

DO $tenant_policies$
DECLARE
  tenant_table text;
  tables text[] := ARRAY[
    'property_domains','property_subscriptions','property_entitlements',
    'support_access_grants','support_sessions','data_import_jobs','data_import_rows',
    'data_import_entities','worker_jobs','worker_attempts','property_webhooks',
    'backup_runs','service_incidents','property_usage_daily'
  ];
BEGIN
  FOREACH tenant_table IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tenant_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tenant_table);
    EXECUTE format('DROP POLICY IF EXISTS aurora_property_isolation ON public.%I',tenant_table);
    EXECUTE format(
      'CREATE POLICY aurora_property_isolation ON public.%I FOR ALL TO aurora_app USING (property_id=public.pms_current_property_id()) WITH CHECK (property_id=public.pms_current_property_id())',
      tenant_table
    );
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO aurora_app',tenant_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon,authenticated',tenant_table);
  END LOOP;
END
$tenant_policies$;

REVOKE ALL ON TABLE public.organizations,public.organization_memberships,public.platform_operators FROM anon,authenticated,aurora_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO aurora_app;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607190016_multihotel_saas_control_plane')
ON CONFLICT(id) DO NOTHING;

COMMIT;
