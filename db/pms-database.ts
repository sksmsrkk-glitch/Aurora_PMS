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

export interface PmsDatabase {
  prepare(query: string): PmsPreparedStatement;
  batch<T = Record<string, unknown>>(statements: PmsPreparedStatement[]): Promise<PmsResult<T>[]>;
  forProperty(propertyId: string): PmsDatabase;
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
] as const;
const tenantTablePattern = new RegExp(`\\b(?:${tenantTables.join("|")})\\b`, "iu");

function assertSafeRootQuery(query: string) {
  if (!tenantTablePattern.test(query)) return;
  const roleLookup =
    /^\s*SELECT\b/iu.test(query) &&
    /\bFROM\s+role_assignments\b/iu.test(query) &&
    /\bemail\s*=\s*\?/iu.test(query) &&
    /\bactive\s*=\s*1\b/iu.test(query) &&
    !tenantTables.some((table) => table !== "role_assignments" && new RegExp(`\\b${table}\\b`, "iu").test(query));
  if (!roleLookup) {
    throw new Error("Tenant-scoped table access requires scopePmsDatabase()");
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
    if (!this.propertyId) assertSafeRootQuery(query);
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
