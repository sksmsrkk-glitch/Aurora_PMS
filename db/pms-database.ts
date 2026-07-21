/** Server-only PostgreSQL adapter with transaction-scoped tenant isolation. */
import postgres from "postgres";
import { compilePostgresParameters } from "./postgres-parameters.mjs";
export { compilePostgresParameters } from "./postgres-parameters.mjs";

export type PmsResult<T = Record<string, unknown>> = {
  results: T[];
  success: true;
  meta: { changes: number };
};

export interface PmsPreparedStatement {
  bind(...values: unknown[]): PmsPreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<PmsResult<T>>;
  run<T = Record<string, unknown>>(): Promise<PmsResult<T>>;
}

export type PropertyAssignment = {
  property_id: string;
  property_name: string;
  property_code: string;
  property_slug: string;
  property_status: string;
  organization_id: string;
  organization_name: string;
  role: string;
  display_name: string;
  workspace_permissions: unknown;
  can_export: boolean;
  must_change_password: boolean;
  subscription_status:string;
  entitlements:unknown;
};

export type PlatformPortfolioRow = PropertyAssignment & {
  plan_code: string;
  subscription_status: string;
  room_limit: number | null;
  user_limit: number | null;
  active_rooms: number;
  active_users: number;
  pending_jobs: number;
  open_incidents: number;
  domains: unknown;
};

export type ProvisionPropertyInput = {
  propertyId: string;
  organizationId: string;
  authUserId: string;
  actorEmail: string;
  actorName: string;
  name: string;
  code: string;
  slug: string;
  timezone: string;
  currency: string;
  businessDate: string;
  planCode: string;
  hostname: string;
  workspacePermissions: unknown;
};

export type WorkerJob = {
  id: string;
  property_id: string;
  job_type: string;
  source_id: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  attempt_cycle: number;
};

export type WorkerRecoverySummary = {
  staleRetried: number;
  staleDead: number;
  deadReset: number;
};

export type SupportAssignment = {
  property_id:string;property_name:string;property_code:string;property_slug:string;organization_id:string;organization_name:string;
  grant_id:string;display_name:string;workspace_permissions:unknown;access_mode:"READ"|"WRITE";pii_mode:"MASKED"|"FULL";
};

export interface PmsDatabase {
  prepare(query: string): PmsPreparedStatement;
  batch<T = Record<string, unknown>>(statements: PmsPreparedStatement[]): Promise<PmsResult<T>[]>;
  forProperty(propertyId: string): PmsDatabase;
  findActiveRoleAssignments(authUserId: string, email: string): Promise<PropertyAssignment[]>;
  findActiveDemoRoleAssignments(email: string): Promise<PropertyAssignment[]>;
  loadPlatformPortfolio(authUserId: string, email: string): Promise<PlatformPortfolioRow[]>;
  resolvePublicProperty(hostname: string): Promise<{property_id:string;property_slug:string;organization_id:string}|null>;
  findActiveSupportAssignments(authUserId:string,email:string):Promise<SupportAssignment[]>;
  recordSupportAccess(input:{grantId:string;authUserId:string;actorEmail:string;write:boolean;requestId:string;action:string}):Promise<boolean>;
  provisionProperty(input: ProvisionPropertyInput): Promise<{propertyId:string;hostname:string}>;
  claimWorkerJobs(workerId: string, limit: number): Promise<WorkerJob[]>;
  recoverWorkerJobs(input:{leaseSeconds:number;deadCooldownSeconds:number;maxRecoveries:number;limit:number}):Promise<WorkerRecoverySummary>;
  enqueueUsageRollups(usageDate:string):Promise<number>;
  finishWorkerJob(input:{jobId:string;workerId:string;outcome:"SUCCEEDED"|"RETRY"|"DEAD";durationMs:number;httpStatus?:number;errorCode?:string;errorMessage?:string}):Promise<boolean>;
}

/**
 * Creates a database view that applies SET LOCAL app.property_id and the
 * NOBYPASSRLS aurora_app role inside every statement transaction.
 */
export function scopePmsDatabase(database: PmsDatabase, propertyId: string): PmsDatabase {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(propertyId)) throw new Error("Invalid property scope");
  return database.forProperty(propertyId);
}

export type PmsRuntimeBindings = {
  DATABASE_URL?: string;
};

type PostgresExecutor = postgres.Sql | postgres.TransactionSql;

const tenantTables = [
  "properties", "room_types", "rooms", "guests", "reservations",
  "reservation_nights", "reservation_type_nights", "reservation_rate_nights",
  "booking_requests", "folio_entries", "folio_entry_details", "folio_windows",
  "folio_routing_rules", "transaction_codes", "housekeeping_tasks", "audit_logs",
  "outbox_events", "idempotency_keys", "cashier_sessions", "night_audits",
  "reservation_transitions", "reservation_mutations", "inventory_controls",
  "room_moves", "account_profiles", "business_blocks", "block_inventory",
  "block_pickup_nights", "rooming_list_entries", "ar_accounts", "ar_invoices",
  "ar_ledger_entries", "channel_connections", "channel_mappings", "ari_updates",
  "channel_reservation_links", "inbound_channel_messages",
  "integration_delivery_attempts", "report_exports", "channel_contracts",
  "channel_rate_overrides", "channel_settlements", "accounting_accounts",
  "accounting_journal_entries", "accounting_journal_lines", "website_settings",
  "room_type_website", "website_media", "role_assignments",
  "rate_plans", "rate_plan_room_types", "rate_plan_calendar", "rate_plan_occupancy",
  "property_domains", "property_subscriptions", "property_entitlements",
  "support_access_grants", "support_sessions", "data_import_jobs",
  "data_import_rows", "data_import_entities", "worker_jobs", "worker_attempts",
  "property_webhooks", "backup_runs", "service_incidents", "property_usage_daily",
] as const;
const tenantTablePattern = new RegExp(`\\b(?:${tenantTables.join("|")})\\b`, "iu");

export function assertSystemOnlyRootQuery(query: string) {
  if (tenantTablePattern.test(query)) {
    throw new Error("Tenant-scoped table access requires scopePmsDatabase() or a dedicated root capability");
  }
}

class PostgresPreparedStatement implements PmsPreparedStatement {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly query: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new PostgresPreparedStatement(this.database, this.query, values);
  }

  async first<T = Record<string, unknown>>() {
    const result = await this.database.execute<T>(this.query, this.values);
    return result.results[0] ?? null;
  }

  all<T = Record<string, unknown>>() {
    return this.database.execute<T>(this.query, this.values);
  }

  run<T = Record<string, unknown>>() {
    return this.database.execute<T>(this.query, this.values);
  }

  executeWith<T>(executor: PostgresExecutor) {
    return this.database.execute<T>(this.query, this.values, executor);
  }

  belongsTo(database: PostgresDatabase) {
    return this.database === database;
  }
}

class PostgresDatabase implements PmsDatabase {
  constructor(
    private readonly client: postgres.Sql,
    private readonly propertyId: string | null = null,
  ) {}

  forProperty(propertyId: string) {
    if (this.propertyId && this.propertyId !== propertyId) {
      throw new Error("Cannot change an established property scope");
    }
    return new PostgresDatabase(this.client, propertyId);
  }

  prepare(query: string) {
    if (query.includes("'prop-seoul'")) {
      throw new Error("Legacy property literal is forbidden; use pms_current_property_id()");
    }
    return new PostgresPreparedStatement(this, query);
  }

  /**
   * The sole root-level tenant lookup is a closed capability, not arbitrary SQL.
   * Authentication supplies an immutable Auth user ID plus the normalized email;
   * requiring both prevents an unlinked legacy email assignment from being
   * claimed by a newly registered Auth account.
   */
  async findActiveRoleAssignments(authUserId: string, email: string) {
    if (this.propertyId) throw new Error("Role assignment lookup requires the root database capability");
    const normalized = email.trim().toLowerCase();
    const normalizedUserId = authUserId.trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalizedUserId)) return [];
    if (!normalized || normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) return [];
    const result = await this.executeRaw<PropertyAssignment>(
      `SELECT ra.property_id,p.name property_name,p.code property_code,p.slug property_slug,
              p.status property_status,p.organization_id,o.name organization_name,
              ra.role,ra.display_name,ra.workspace_permissions,ra.can_export,ra.must_change_password,
              COALESCE((SELECT s.status FROM property_subscriptions s WHERE s.property_id=p.id),'ACTIVE') subscription_status,
              COALESCE((SELECT jsonb_object_agg(e.feature_key,e.enabled) FROM property_entitlements e WHERE e.property_id=p.id),'{}'::jsonb) entitlements
         FROM role_assignments ra
         JOIN properties p ON p.id=ra.property_id
         JOIN organizations o ON o.id=p.organization_id
        WHERE ra.auth_user_id=?::uuid AND lower(ra.email)=? AND ra.active
          AND p.status IN ('TRIAL','ACTIVE') AND o.status IN ('TRIAL','ACTIVE')
          AND NOT EXISTS(SELECT 1 FROM property_subscriptions s WHERE s.property_id=p.id AND s.status IN ('SUSPENDED','CANCELLED'))
        ORDER BY p.name,ra.created_at`,
      [normalizedUserId, normalized],
      this.client,
    );
    return result.results;
  }

  /** Explicitly isolated compatibility lookup for the opt-in, non-production demo. */
  async findActiveDemoRoleAssignments(email: string) {
    if (this.propertyId) throw new Error("Demo role assignment lookup requires the root database capability");
    const normalized = email.trim().toLowerCase();
    if (!normalized || normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) return [];
    const result = await this.executeRaw<PropertyAssignment>(
      `SELECT ra.property_id,p.name property_name,p.code property_code,p.slug property_slug,
              p.status property_status,p.organization_id,o.name organization_name,
              ra.role,ra.display_name,ra.workspace_permissions,ra.can_export,ra.must_change_password,
              COALESCE((SELECT s.status FROM property_subscriptions s WHERE s.property_id=p.id),'ACTIVE') subscription_status,
              COALESCE((SELECT jsonb_object_agg(e.feature_key,e.enabled) FROM property_entitlements e WHERE e.property_id=p.id),'{}'::jsonb) entitlements
         FROM role_assignments ra
         JOIN properties p ON p.id=ra.property_id
         JOIN organizations o ON o.id=p.organization_id
        WHERE lower(ra.email)=? AND ra.active
          AND p.status IN ('TRIAL','ACTIVE') AND o.status IN ('TRIAL','ACTIVE')
          AND NOT EXISTS(SELECT 1 FROM property_subscriptions s WHERE s.property_id=p.id AND s.status IN ('SUSPENDED','CANCELLED'))
        ORDER BY p.name,ra.created_at`,
      [normalized],
      this.client,
    );
    return result.results;
  }

  /** A closed, read-only control-plane capability used by the portfolio screen. */
  async loadPlatformPortfolio(authUserId: string, email: string) {
    if (this.propertyId) throw new Error("Platform portfolio lookup requires the root database capability");
    const normalized=email.trim().toLowerCase(),normalizedUserId=authUserId.trim().toLowerCase();
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalizedUserId))return [];
    if(!normalized||normalized.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized))return [];
    const result=await this.executeRaw<PlatformPortfolioRow>(
      `SELECT ra.property_id,p.name property_name,p.code property_code,p.slug property_slug,
              p.status property_status,p.organization_id,o.name organization_name,
              ra.role,ra.display_name,ra.workspace_permissions,ra.can_export,ra.must_change_password,
              COALESCE(s.plan_code,p.plan_code) plan_code,COALESCE(s.status,'ACTIVE') subscription_status,
              s.room_limit,s.user_limit,
              (SELECT COUNT(*)::int FROM rooms r WHERE r.property_id=p.id AND r.active) active_rooms,
              (SELECT COUNT(*)::int FROM role_assignments u WHERE u.property_id=p.id AND u.active) active_users,
              (SELECT COUNT(*)::int FROM worker_jobs w WHERE w.property_id=p.id AND w.status IN ('PENDING','RETRY','RUNNING')) pending_jobs,
              (SELECT COUNT(*)::int FROM service_incidents i WHERE i.property_id=p.id AND i.status<>'RESOLVED') open_incidents,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('id',d.id,'hostname',d.hostname,'kind',d.kind,'status',d.status,'primary',d.is_primary) ORDER BY d.is_primary DESC,d.hostname)
                          FROM property_domains d WHERE d.property_id=p.id),'[]'::jsonb) domains
         FROM role_assignments ra
         JOIN properties p ON p.id=ra.property_id
         JOIN organizations o ON o.id=p.organization_id
         LEFT JOIN property_subscriptions s ON s.property_id=p.id
        WHERE ra.auth_user_id=?::uuid AND lower(ra.email)=? AND ra.active
          AND p.status<>'CLOSED' AND o.status<>'CLOSED'
        ORDER BY o.name,p.name`,
      [normalizedUserId,normalized],this.client,
    );
    return result.results;
  }

  /** Resolves a trusted hostname without accepting a client-supplied property id. */
  async resolvePublicProperty(hostname: string) {
    if(this.propertyId)throw new Error("Public property resolution requires the root database capability");
    const normalized=hostname.trim().toLowerCase().replace(/\.$/u,"");
    if(normalized.length>253||!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(normalized))return null;
    const result=await this.executeRaw<{property_id:string;property_slug:string;organization_id:string}>(
      `SELECT d.property_id,p.slug property_slug,p.organization_id
         FROM property_domains d JOIN properties p ON p.id=d.property_id
         JOIN organizations o ON o.id=p.organization_id
        WHERE d.hostname=? AND d.status='ACTIVE' AND p.status IN ('TRIAL','ACTIVE')
          AND o.status IN ('TRIAL','ACTIVE')
          AND NOT EXISTS(
            SELECT 1 FROM property_subscriptions s
             WHERE s.property_id=p.id AND s.status IN ('SUSPENDED','CANCELLED')
          ) LIMIT 1`,
      [normalized],this.client,
    );
    return result.results[0]??null;
  }

  /** Closed JIT support lookup: identity, MFA enforcement and grant selection are
   * handled by auth.ts; this capability never accepts arbitrary SQL or scope. */
  async findActiveSupportAssignments(authUserId:string,email:string){
    if(this.propertyId)throw new Error("Support lookup requires the root database capability");
    const userId=authUserId.trim().toLowerCase(),normalized=email.trim().toLowerCase();
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(userId)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized))return [];
    const result=await this.executeRaw<SupportAssignment>(
      `SELECT g.property_id,p.name property_name,p.code property_code,p.slug property_slug,
              p.organization_id,o.name organization_name,g.id grant_id,po.display_name,
              g.workspace_permissions,g.access_mode,g.pii_mode
         FROM platform_operators po
         JOIN support_access_grants g ON g.operator_user_id=po.auth_user_id
         JOIN properties p ON p.id=g.property_id
         JOIN organizations o ON o.id=p.organization_id
        WHERE po.auth_user_id=?::uuid AND lower(po.email)=? AND po.active
           AND lower(g.operator_email)=? AND g.revoked_at IS NULL
           AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp()
           AND EXISTS(SELECT 1 FROM property_entitlements e WHERE e.property_id=p.id AND e.feature_key='SUPPORT_ACCESS' AND e.enabled)
           AND p.status IN ('TRIAL','ACTIVE') AND o.status IN ('TRIAL','ACTIVE')
           AND NOT EXISTS(SELECT 1 FROM property_subscriptions s WHERE s.property_id=p.id AND s.status IN ('SUSPENDED','CANCELLED'))
        ORDER BY p.name,g.expires_at DESC`,
      [userId,normalized,normalized],this.client,
    );
    return result.results;
  }

  /** Records every support request in an expiring session and tenant audit log.
   * The active grant is rechecked under lock so a concurrent revoke wins. */
  async recordSupportAccess(input:{grantId:string;authUserId:string;actorEmail:string;write:boolean;requestId:string;action:string}){
    if(this.propertyId)throw new Error("Support audit requires the root database capability");
    const userId=input.authUserId.trim().toLowerCase(),email=input.actorEmail.trim().toLowerCase();
    if(!/^[A-Za-z0-9:_-]{3,200}$/u.test(input.grantId)||!/^[0-9a-f-]{36}$/u.test(userId)||!/^[A-Za-z0-9:_-]{8,200}$/u.test(input.requestId))return false;
    return this.client.begin(async transaction=>{
      const grant=await this.executeRaw<{property_id:string;pii_mode:string}>(
        `SELECT g.property_id,g.pii_mode FROM support_access_grants g
          JOIN platform_operators po ON po.auth_user_id=g.operator_user_id
          JOIN properties p ON p.id=g.property_id JOIN organizations o ON o.id=p.organization_id
          WHERE g.id=? AND g.operator_user_id=?::uuid AND lower(g.operator_email)=?
            AND po.active AND lower(po.email)=? AND g.revoked_at IS NULL
            AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp()
            AND (?::boolean=false OR g.access_mode='WRITE')
            AND p.status IN ('TRIAL','ACTIVE') AND o.status IN ('TRIAL','ACTIVE')
            AND EXISTS(SELECT 1 FROM property_entitlements e WHERE e.property_id=g.property_id AND e.feature_key='SUPPORT_ACCESS' AND e.enabled)
            AND NOT EXISTS(SELECT 1 FROM property_subscriptions s WHERE s.property_id=g.property_id AND s.status IN ('SUSPENDED','CANCELLED'))
          FOR UPDATE OF g`,[input.grantId,userId,email,email,input.write],transaction,
      );
      if(!grant.results[0])return false;
      const sessionId=`support-session-${input.grantId}-${userId.slice(0,8)}`;
      await this.executeRaw(
        `INSERT INTO support_sessions(id,property_id,grant_id,operator_user_id,started_at,last_seen_at,request_count,write_count)
         VALUES (?,?,?,?::uuid,clock_timestamp(),clock_timestamp(),1,?)
         ON CONFLICT(id) DO UPDATE SET last_seen_at=clock_timestamp(),request_count=support_sessions.request_count+1,
           write_count=support_sessions.write_count+EXCLUDED.write_count,ended_at=NULL`,
        [sessionId,grant.results[0].property_id,input.grantId,userId,input.write?1:0],transaction,
      );
      await this.executeRaw(
        `INSERT INTO audit_logs(id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at)
         VALUES (?,?,?,'SUPPORT_ACCESS','support_session',?,NULL,jsonb_build_object('requestId',?::text,'operation',?::text,'write',?::boolean,'piiMode',?::text),clock_timestamp())`,
        [`audit-support-${input.requestId}`,grant.results[0].property_id,email,sessionId,input.requestId,input.action.slice(0,120),input.write,grant.results[0].pii_mode],transaction,
      );
      return true;
    });
  }

  /**
   * Atomically provisions a sibling hotel for an existing organization owner.
   * The caller cannot supply SQL, roles, entitlements or accounting rows; this
   * structured capability is the only root-level write path.
   */
  async provisionProperty(input: ProvisionPropertyInput) {
    if(this.propertyId)throw new Error("Hotel provisioning requires the root database capability");
    const id=input.propertyId.trim(),organizationId=input.organizationId.trim(),userId=input.authUserId.trim().toLowerCase();
    const email=input.actorEmail.trim().toLowerCase(),slug=input.slug.trim().toLowerCase(),hostname=input.hostname.trim().toLowerCase();
    if(!/^prop-[a-z0-9][a-z0-9-]{2,61}$/u.test(id)||!/^org-[A-Za-z0-9_-]{3,64}$/u.test(organizationId))throw new Error("Invalid provisioning scope");
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(userId))throw new Error("Invalid provisioning identity");
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)||!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(slug))throw new Error("Invalid provisioning identity or slug");
    if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(hostname))throw new Error("Invalid provisioning hostname");
    return this.client.begin(async(transaction)=>{
      await transaction.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))",[`aurora:provision:${slug}`] as never[]);
      const membership=await this.executeRaw<{allowed:boolean}>(
        `SELECT EXISTS(SELECT 1 FROM organization_memberships
          WHERE organization_id=? AND auth_user_id=?::uuid AND lower(email)=?
            AND active AND role IN ('OWNER','ADMIN')) allowed`,
        [organizationId,userId,email],transaction,
      );
      if(!membership.results[0]?.allowed)throw new Error("Organization owner access is required");
      const existing=await this.executeRaw<{property_id:string;hostname:string}>(
        `SELECT p.id property_id,COALESCE((SELECT d.hostname FROM property_domains d WHERE d.property_id=p.id AND d.is_primary ORDER BY d.created_at LIMIT 1),'') hostname
           FROM properties p JOIN role_assignments ra ON ra.property_id=p.id
          WHERE p.organization_id=? AND p.slug=? AND ra.auth_user_id=?::uuid AND ra.active LIMIT 1`,
        [organizationId,slug,userId],transaction,
      );
      if(existing.results[0])return {propertyId:existing.results[0].property_id,hostname:existing.results[0].hostname};
      await this.executeRaw(
        `INSERT INTO properties(id,name,code,timezone,currency,business_date,organization_id,slug,status,onboarding_status,plan_code,cell_key,settings,created_at,updated_at)
         VALUES (?,?,?,?,?,?::date,?,?,'TRIAL','READY',?,'primary','{}'::jsonb,clock_timestamp(),clock_timestamp())`,
        [id,input.name.trim(),input.code.trim().toUpperCase(),input.timezone.trim(),input.currency.trim().toUpperCase(),input.businessDate,organizationId,slug,input.planCode.trim().toUpperCase()],transaction,
      );
      await this.executeRaw(
        `INSERT INTO role_assignments(id,property_id,email,role,active,created_at,auth_user_id,display_name,workspace_permissions,can_export,must_change_password,version,updated_at,updated_by)
         VALUES (?,?,?,?,true,clock_timestamp(),?::uuid,?,?::jsonb,true,false,1,clock_timestamp(),?)`,
        [`role-${id}-${userId.slice(0,8)}`,id,email,"PROPERTY_ADMIN",userId,input.actorName.trim(),input.workspacePermissions,email],transaction,
      );
      await this.executeRaw(
        `INSERT INTO property_domains(id,property_id,hostname,kind,status,is_primary,verified_at)
         VALUES (?,?,?,'SUBDOMAIN','ACTIVE',true,clock_timestamp())`,
        [`domain-${id}-primary`,id,hostname],transaction,
      );
      await this.executeRaw(
        `INSERT INTO property_subscriptions(id,property_id,plan_code,status,room_limit,user_limit,trial_ends_at,current_period_start,current_period_end)
         VALUES (?,?,?,'TRIALING',250,30,clock_timestamp()+interval '30 days',?::date,(?::date+interval '29 days')::date)`,
        [`subscription-${id}`,id,input.planCode.trim().toUpperCase(),input.businessDate,input.businessDate],transaction,
      );
      for(const feature of ["CORE_PMS","DIRECT_BOOKING","WEBSITE_CMS","REPORT_EXPORT","ACCOUNTING","CHANNEL_HUB","GROUP_SALES","STAFF_ACCESS","DATA_IMPORT","SUPPORT_ACCESS"]){
        await this.executeRaw("INSERT INTO property_entitlements(property_id,feature_key,enabled,limits,updated_by) VALUES (?,?,true,'{}'::jsonb,?)",[id,feature,email],transaction);
      }
      await this.executeRaw(
        `INSERT INTO transaction_codes(id,property_id,code,name,category,tax_rate,service_rate,active)
         SELECT 'tc-'||?||'-'||lower(v.code),?,v.code,v.name,v.category,v.tax_rate,v.service_rate,true
         FROM (VALUES ('ROOM','객실료','ROOM',10::numeric,0::numeric),('FNB','식음료','FNB',10,0),('CASH','현금','PAYMENT',0,0),('CARD','신용카드','PAYMENT',0,0),('DIRECT_BILL','후불 이관','PAYMENT',0,0)) v(code,name,category,tax_rate,service_rate)`,
        [id,id],transaction,
      );
      await this.executeRaw(
        `INSERT INTO accounting_accounts(id,property_id,code,name,account_type,category,department,active,created_at,updated_at)
         SELECT 'acct-'||?||'-'||v.code,?,v.code,v.name,v.account_type,v.category,v.department,true,clock_timestamp(),clock_timestamp()
         FROM (VALUES ('1100','Cash and deposits','ASSET','CASH','FINANCE'),('1200','Channel receivables','ASSET','CHANNEL_RECEIVABLE','FINANCE'),('1300','Accounts receivable','ASSET','ACCOUNTS_RECEIVABLE','FINANCE'),('2100','Accounts payable','LIABILITY','ACCOUNTS_PAYABLE','FINANCE'),('2200','Channel commission payable','LIABILITY','CHANNEL_COMMISSION_PAYABLE','FINANCE'),('2300','Tax payable','LIABILITY','TAX_PAYABLE','FINANCE'),('4100','Room revenue','REVENUE','ROOM_REVENUE','ROOMS'),('4200','Other operating revenue','REVENUE','OTHER_REVENUE','OPERATIONS'),('5100','Channel distribution expense','EXPENSE','CHANNEL_DISTRIBUTION','SALES'),('5200','Hotel operating expense','EXPENSE','OPERATING_EXPENSE','OPERATIONS'),('5990','Adjustment gain or loss','EXPENSE','ADJUSTMENT','FINANCE')) v(code,name,account_type,category,department)`,
        [id,id],transaction,
      );
      await this.executeRaw(
        `INSERT INTO website_settings(property_id,hotel_name,brand_eyebrow,hero_title,hero_subtitle,overview_title,overview_body,experience_title,experience_body,location_title,location_body,address,phone,email,checkin_time,checkout_time,published,version,updated_at,updated_by)
         VALUES (?,?,?,'새로운 호텔 경험을 준비하고 있습니다','호텔 소개와 객실을 설정한 뒤 홈페이지를 공개하세요','호텔 소개','Talos PMS Website Studio에서 호텔 소개를 입력하세요','호텔 경험','호텔만의 경험을 소개하세요','오시는 길','주소와 교통 정보를 입력하세요','주소 입력 필요','전화번호 입력 필요',?,'15:00','11:00',false,1,clock_timestamp(),?)`,
        [id,input.name.trim(),input.name.trim().toUpperCase(),email,email],transaction,
      );
      await this.executeRaw(
        `INSERT INTO rate_plans(id,property_id,code,name,description,currency,market_segment,meal_plan,cancellation_policy,guarantee_policy,pricing_model,adjustment,min_stay,max_stay,active,version,created_at,updated_at,created_by,updated_by)
         SELECT 'rp-'||?||'-'||lower(v.code),?,v.code,v.name,v.description,?,'TRANSIENT','ROOM_ONLY','FLEXIBLE','CARD_GUARANTEE','FIXED',0,1,30,true,1,clock_timestamp(),clock_timestamp(),?,?
         FROM (VALUES ('BAR','Best Available Rate','호텔 표준 유연 요금'),('WEB-DIRECT','공식 홈페이지 전용','공식 홈페이지 실시간 판매 요금'),('OTA','온라인 채널 표준','OTA 채널 매핑 기본 요금')) v(code,name,description)`,
        [id,id,input.currency.trim().toUpperCase(),email,email],transaction,
      );
      await this.executeRaw(
        `INSERT INTO audit_logs(id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at)
         VALUES (?,?,?,'PROVISION_PROPERTY','property',?,NULL,jsonb_build_object('organizationId',?::text,'hostname',?::text,'planCode',?::text),clock_timestamp())`,
        [`audit-provision-${id}`,id,email,id,organizationId,hostname,input.planCode.trim().toUpperCase()],transaction,
      );
      return {propertyId:id,hostname};
    });
  }

  /** Claims jobs across properties with SKIP LOCKED; no tenant payload can alter SQL. */
  async enqueueUsageRollups(usageDate:string){
    if(this.propertyId)throw new Error("Usage scheduling requires the root database capability");
    if(!/^\d{4}-\d{2}-\d{2}$/u.test(usageDate))throw new Error("Invalid usage date");
    const result=await this.executeRaw(
      `INSERT INTO worker_jobs(id,property_id,job_type,source_id,payload,status,priority,available_at)
       SELECT 'job-usage-'||p.id||'-'||?,p.id,'USAGE_ROLLUP',?,jsonb_build_object('usageDate',?::text),'PENDING',120,clock_timestamp()
         FROM properties p JOIN organizations o ON o.id=p.organization_id
        WHERE p.status IN ('TRIAL','ACTIVE') AND o.status IN ('TRIAL','ACTIVE')
       ON CONFLICT(property_id,job_type,source_id) DO NOTHING`,
      [usageDate,usageDate,usageDate],this.client,
    );
    return result.meta.changes;
  }

  /** Claims jobs across properties with SKIP LOCKED; no tenant payload can alter SQL. */
  async claimWorkerJobs(workerId: string, limit: number) {
    if(this.propertyId)throw new Error("Worker claims require the root database capability");
    if(!/^[A-Za-z0-9:_-]{3,100}$/u.test(workerId)||!Number.isInteger(limit)||limit<1||limit>25)throw new Error("Invalid worker claim");
    return this.client.begin(async(transaction)=>{
      // A claim is the final durability boundary, so it must not depend on the
      // scheduler having called recoverWorkerJobs first. Reap leases that have
      // been abandoned for ten minutes while holding row locks in this same
      // transaction; a concurrent worker can never reclaim the same job.
      const expired=await this.executeRaw<{id:string;property_id:string;job_type:string;attempts:number;max_attempts:number;attempt_cycle:number}>(
        `SELECT id,property_id,job_type,attempts,max_attempts,attempt_cycle FROM worker_jobs
          WHERE status='RUNNING' AND locked_at<=clock_timestamp()-interval '10 minutes'
          ORDER BY locked_at,id FOR UPDATE SKIP LOCKED LIMIT 100`,
        [],transaction,
      );
      for(const job of expired.results){
        const outcome=job.attempts<job.max_attempts?"RETRY":"DEAD";
        await this.executeRaw(
          `UPDATE worker_jobs SET status=?,available_at=CASE WHEN ?='RETRY' THEN clock_timestamp() ELSE available_at END,
             completed_at=CASE WHEN ?='DEAD' THEN clock_timestamp() ELSE NULL END,locked_at=NULL,locked_by=NULL,
             last_error='Worker lease expired before completion',updated_at=clock_timestamp() WHERE id=?`,
          [outcome,outcome,outcome,job.id],transaction,
        );
        // Close every unfinished ledger row for the reclaimed job. Matching
        // only the latest attempt would leave earlier crash residue orphaned.
        await this.executeRaw(
          `UPDATE worker_attempts SET completed_at=clock_timestamp(),outcome=?,
             duration_ms=LEAST(2147483647,GREATEST(0,floor(extract(epoch FROM (clock_timestamp()-started_at))*1000)::bigint))::integer,
             error_code='LEASE_EXPIRED'
           WHERE job_id=? AND completed_at IS NULL`,
          [outcome,job.id],transaction,
        );
        if(outcome==="DEAD")await this.executeRaw(
          `INSERT INTO service_incidents(id,property_id,component,severity,status,summary,started_at,metadata)
           VALUES ('incident-'||?, ?, ?, 'CRITICAL','OPEN','Worker lease expired at the retry limit',clock_timestamp(),jsonb_build_object('jobId',?::text,'attempts',?::integer,'attemptCycle',?::integer))
           ON CONFLICT(id) DO UPDATE SET status='OPEN',summary=excluded.summary,metadata=excluded.metadata,resolved_at=NULL`,
          [job.id,job.property_id,job.job_type,job.id,job.attempts,job.attempt_cycle],transaction,
        );
      }
      const claimed=await this.executeRaw<WorkerJob>(
        `WITH candidates AS (
           SELECT id FROM worker_jobs
            WHERE status IN ('PENDING','RETRY') AND available_at<=clock_timestamp()
              AND attempts<max_attempts
            ORDER BY priority,available_at,created_at
            FOR UPDATE SKIP LOCKED LIMIT ?
         )
         UPDATE worker_jobs j SET status='RUNNING',attempts=j.attempts+1,locked_at=clock_timestamp(),locked_by=?,updated_at=clock_timestamp()
          FROM candidates c WHERE j.id=c.id
         RETURNING j.id,j.property_id,j.job_type,j.source_id,j.payload,j.attempts,j.max_attempts,j.attempt_cycle`,
        [limit,workerId],transaction,
      );
      for(const job of claimed.results){
        await this.executeRaw("INSERT INTO worker_attempts(property_id,job_id,attempt_cycle,attempt_no,started_at) VALUES (?,?,?,?,clock_timestamp())",[job.property_id,job.id,job.attempt_cycle,job.attempts],transaction);
      }
      return claimed.results;
    });
  }

  async finishWorkerJob(input:{jobId:string;workerId:string;outcome:"SUCCEEDED"|"RETRY"|"DEAD";durationMs:number;httpStatus?:number;errorCode?:string;errorMessage?:string}) {
    if(this.propertyId)throw new Error("Worker completion requires the root database capability");
    if(!/^[A-Za-z0-9:_-]{3,200}$/u.test(input.jobId)||!/^[A-Za-z0-9:_-]{3,100}$/u.test(input.workerId)||!Number.isInteger(input.durationMs)||input.durationMs<0)throw new Error("Invalid worker completion");
    return this.client.begin(async(transaction)=>{
      const current=await this.executeRaw<{property_id:string;job_type:string;attempts:number;max_attempts:number;attempt_cycle:number;recovery_count:number}>("SELECT property_id,job_type,attempts,max_attempts,attempt_cycle,recovery_count FROM worker_jobs WHERE id=? AND status='RUNNING' AND locked_by=? FOR UPDATE",[input.jobId,input.workerId],transaction);
      const job=current.results[0];if(!job)return false;
      const outcome=input.outcome==="RETRY"&&job.attempts>=job.max_attempts?"DEAD":input.outcome;
      const delaySeconds=Math.min(3600,Math.max(5,2**Math.min(job.attempts,10)*5));
      await this.executeRaw(
        `UPDATE worker_jobs SET status=?,available_at=CASE WHEN ?='RETRY' THEN clock_timestamp()+(?||' seconds')::interval ELSE available_at END,
                completed_at=CASE WHEN ? IN ('SUCCEEDED','DEAD') THEN clock_timestamp() ELSE NULL END,
                locked_at=NULL,locked_by=NULL,last_error=?,updated_at=clock_timestamp()
          WHERE id=?`,
        [outcome,outcome,String(delaySeconds),outcome,(input.errorMessage||"").slice(0,2000)||null,input.jobId],transaction,
      );
      await this.executeRaw(
        "UPDATE worker_attempts SET completed_at=clock_timestamp(),outcome=?,http_status=?,duration_ms=?,error_code=? WHERE job_id=? AND attempt_cycle=? AND attempt_no=?",
        [outcome,input.httpStatus??null,input.durationMs,(input.errorCode||"").slice(0,100)||null,input.jobId,job.attempt_cycle,job.attempts],transaction,
      );
      if(outcome==="DEAD"){
        await this.executeRaw(
          `INSERT INTO service_incidents(id,property_id,component,severity,status,summary,started_at,metadata)
           VALUES ('incident-'||?, ?, ?, 'CRITICAL','OPEN',?,clock_timestamp(),jsonb_build_object('jobId',?::text,'attempts',?::integer,'attemptCycle',?::integer,'recoveryCount',?::integer))
           ON CONFLICT(id) DO UPDATE SET status='OPEN',summary=excluded.summary,metadata=excluded.metadata,resolved_at=NULL`,
          [input.jobId,job.property_id,job.job_type,`Durable delivery exhausted its retry budget: ${(input.errorMessage||"unknown error").slice(0,300)}`,input.jobId,job.attempts,job.attempt_cycle,job.recovery_count],transaction,
        );
      }else if(outcome==="SUCCEEDED"){
        await this.executeRaw("UPDATE service_incidents SET status='RESOLVED',resolved_at=clock_timestamp() WHERE id='incident-'||? AND property_id=? AND status<>'RESOLVED'",[input.jobId,job.property_id],transaction);
      }
      return true;
    });
  }

  /** Reclaims expired leases and performs a bounded recovery cycle for critical
   * delivery jobs. Poison jobs remain DEAD after maxRecoveries, avoiding an
   * infinite retry storm while preserving every attempt in worker_attempts. */
  async recoverWorkerJobs(input:{leaseSeconds:number;deadCooldownSeconds:number;maxRecoveries:number;limit:number}){
    if(this.propertyId)throw new Error("Worker recovery requires the root database capability");
    const {leaseSeconds,deadCooldownSeconds,maxRecoveries,limit}=input;
    if(!Number.isInteger(leaseSeconds)||leaseSeconds<90||leaseSeconds>3600||!Number.isInteger(deadCooldownSeconds)||deadCooldownSeconds<60||deadCooldownSeconds>86400||!Number.isInteger(maxRecoveries)||maxRecoveries<0||maxRecoveries>10||!Number.isInteger(limit)||limit<1||limit>250)throw new Error("Invalid worker recovery policy");
    return this.client.begin(async transaction=>{
      const stale=await this.executeRaw<{id:string;property_id:string;job_type:string;attempts:number;max_attempts:number;attempt_cycle:number}>(
        `SELECT id,property_id,job_type,attempts,max_attempts,attempt_cycle FROM worker_jobs
          WHERE status='RUNNING' AND locked_at<=clock_timestamp()-(?||' seconds')::interval
          ORDER BY locked_at,id FOR UPDATE SKIP LOCKED LIMIT ?`,
        [String(leaseSeconds),limit],transaction,
      );
      let staleRetried=0,staleDead=0;
      for(const job of stale.results){
        const outcome=job.attempts>=job.max_attempts?"DEAD":"RETRY";
        if(outcome==="DEAD")staleDead+=1;else staleRetried+=1;
        await this.executeRaw(
          `UPDATE worker_jobs SET status=?,available_at=CASE WHEN ?='RETRY' THEN clock_timestamp() ELSE available_at END,
             completed_at=CASE WHEN ?='DEAD' THEN clock_timestamp() ELSE NULL END,locked_at=NULL,locked_by=NULL,
             last_error='Worker lease expired before completion',updated_at=clock_timestamp() WHERE id=?`,
          [outcome,outcome,outcome,job.id],transaction,
        );
        await this.executeRaw(
          `UPDATE worker_attempts SET completed_at=clock_timestamp(),outcome=?,
             duration_ms=LEAST(2147483647,GREATEST(0,floor(extract(epoch FROM (clock_timestamp()-started_at))*1000)::bigint))::integer,
             error_code='LEASE_EXPIRED' WHERE job_id=? AND attempt_cycle=? AND attempt_no=? AND completed_at IS NULL`,
          [outcome,job.id,job.attempt_cycle,job.attempts],transaction,
        );
        if(outcome==="DEAD")await this.executeRaw(
          `INSERT INTO service_incidents(id,property_id,component,severity,status,summary,started_at,metadata)
           VALUES ('incident-'||?, ?, ?, 'CRITICAL','OPEN','Worker lease expired at the retry limit',clock_timestamp(),jsonb_build_object('jobId',?::text,'attempts',?::integer,'attemptCycle',?::integer))
           ON CONFLICT(id) DO UPDATE SET status='OPEN',summary=excluded.summary,metadata=excluded.metadata,resolved_at=NULL`,
          [job.id,job.property_id,job.job_type,job.id,job.attempts,job.attempt_cycle],transaction,
        );
      }
      if(maxRecoveries===0)return {staleRetried,staleDead,deadReset:0};
      const recoverable=await this.executeRaw<{id:string}>(
        `SELECT id FROM worker_jobs WHERE job_type IN ('OUTBOX_WEBHOOK','ARI_DELIVERY')
          AND (status='DEAD' OR (status='RETRY' AND attempts>=max_attempts))
          AND COALESCE(completed_at,updated_at)<=clock_timestamp()-(?||' seconds')::interval AND recovery_count<?
          ORDER BY priority,COALESCE(completed_at,updated_at),created_at FOR UPDATE SKIP LOCKED LIMIT ?`,
        [String(deadCooldownSeconds),maxRecoveries,limit],transaction,
      );
      for(const job of recoverable.results)await this.executeRaw(
        `UPDATE worker_jobs SET status='RETRY',attempts=0,attempt_cycle=attempt_cycle+1,recovery_count=recovery_count+1,
           last_recovered_at=clock_timestamp(),available_at=clock_timestamp(),completed_at=NULL,locked_at=NULL,locked_by=NULL,
           last_error='Automated DEAD delivery recovery scheduled',updated_at=clock_timestamp() WHERE id=?`,
        [job.id],transaction,
      );
      return {staleRetried,staleDead,deadReset:recoverable.results.length};
    });
  }

  private async configureTenant(transaction: postgres.TransactionSql) {
    if (!this.propertyId) return;
    await transaction.unsafe("SET LOCAL ROLE aurora_app");
    await transaction.unsafe(
      "SELECT set_config('app.property_id', $1, true)",
      [this.propertyId] as never[],
    );
  }

  private async executeRaw<T>(
    query: string,
    values: unknown[],
    executor: PostgresExecutor,
  ): Promise<PmsResult<T>> {
    const sql = compilePostgresParameters(query, values.length);
    const rows = await executor.unsafe(sql, values as never[]);
    const resultRows = Array.from(rows) as T[];
    const changes = typeof rows.count === "number" ? rows.count : resultRows.length;
    return { results: resultRows, success: true, meta: { changes } };
  }

  async execute<T>(
    query: string,
    values: unknown[],
    executor?: PostgresExecutor,
  ): Promise<PmsResult<T>> {
    if (!this.propertyId) assertSystemOnlyRootQuery(query);
    if (executor) return this.executeRaw<T>(query, values, executor);
    if (!this.propertyId) return this.executeRaw<T>(query, values, this.client);

    // SET LOCAL is transaction-bound, so a pooled connection can never retain a
    // previous request's property id or application role.
    return this.client.begin(async (transaction) => {
      await this.configureTenant(transaction);
      return this.executeRaw<T>(query, values, transaction);
    });
  }

  async batch<T = Record<string, unknown>>(statements: PmsPreparedStatement[]) {
    if (!statements.length) return [];

    // One PostgreSQL transaction preserves both tenant context and all-or-nothing
    // reservation, inventory, audit, outbox, and accounting semantics.
    return this.client.begin(async (transaction) => {
      await this.configureTenant(transaction);
      const results: PmsResult<T>[] = [];
      for (const statement of statements) {
        if (!(statement instanceof PostgresPreparedStatement) || !statement.belongsTo(this)) {
          throw new Error("Cannot batch a statement created by another database scope");
        }
        results.push(await statement.executeWith<T>(transaction));
      }
      return results;
    });
  }
}

let postgresClient: postgres.Sql | null = null;
let postgresUrl: string | null = null;

function processDatabaseUrl() {
  if (typeof process === "undefined") return undefined;
  return process.env.DATABASE_URL;
}

export function getPmsDatabase(bindings: PmsRuntimeBindings): PmsDatabase {
  const databaseUrl = bindings.DATABASE_URL || processDatabaseUrl();
  if (!databaseUrl) throw new Error("PMS database is unavailable. Configure DATABASE_URL.");

  if (!postgresClient || postgresUrl !== databaseUrl) {
    const localDatabase = /^postgres(?:ql)?:\/\/[^/]+@(?:localhost|127\.0\.0\.1)(?::\d+)?\//iu.test(databaseUrl);
    postgresClient = postgres(databaseUrl, {
      max: 6,
      prepare: false,
      connect_timeout: 12,
      idle_timeout: 20,
      max_lifetime: 60 * 15,
      ssl: localDatabase ? false : "require",
      // A hotel business/stay date has no timezone. Returning PostgreSQL DATE as
      // YYYY-MM-DD prevents UTC Date objects from corrupting map keys or moving a
      // stay date when a server/client timezone differs.
      types: {
        dateOnly: {
          to: 1082,
          from: [1082],
          serialize: (value: unknown) => String(value).slice(0, 10),
          parse: (value: string) => value,
        },
      },
      transform: { undefined: null },
    });
    postgresUrl = databaseUrl;
  }
  return new PostgresDatabase(postgresClient);
}

/** Releases the shared pool during one-shot workers and integration test teardown. */
export async function closePmsDatabase() {
  if (postgresClient) await postgresClient.end({ timeout: 5 });
  postgresClient = null;
  postgresUrl = null;
}
