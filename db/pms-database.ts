/** Server-only PostgreSQL adapter for the Aurora PMS command/query contract. */
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
}

/**
 * Temporary tenant boundary retained until the following migration step replaces
 * legacy seed literals with a transaction-local PostgreSQL property context.
 */
export function scopePmsDatabase(database: PmsDatabase, propertyId: string): PmsDatabase {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(propertyId)) throw new Error("Invalid property scope");
  const quotedPropertyId = `'${propertyId}'`;
  return {
    prepare(query: string) {
      return database.prepare(query.replaceAll("'prop-seoul'", quotedPropertyId));
    },
    batch<T = Record<string, unknown>>(statements: PmsPreparedStatement[]) {
      return database.batch<T>(statements);
    },
  };
}

export type PmsRuntimeBindings = {
  DATABASE_URL?: string;
};

type PostgresExecutor = postgres.Sql | postgres.TransactionSql;

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
}

class PostgresDatabase implements PmsDatabase {
  constructor(private readonly client: postgres.Sql) {}

  prepare(query: string) {
    return new PostgresPreparedStatement(this, query);
  }

  async execute<T>(
    query: string,
    values: unknown[],
    executor: PostgresExecutor = this.client,
  ): Promise<PmsResult<T>> {
    const sql = compilePostgresParameters(query, values.length);
    const rows = await executor.unsafe(sql, values as never[]);
    const resultRows = Array.from(rows) as T[];
    const changes = typeof rows.count === "number" ? rows.count : resultRows.length;
    return { results: resultRows, success: true, meta: { changes } };
  }

  async batch<T = Record<string, unknown>>(statements: PmsPreparedStatement[]) {
    if (!statements.length) return [];

    // One PostgreSQL transaction preserves the all-or-nothing semantics expected
    // by reservation, inventory, audit, outbox, and accounting command batches.
    return this.client.begin(async (transaction) => {
      const results: PmsResult<T>[] = [];
      for (const statement of statements) {
        if (!(statement instanceof PostgresPreparedStatement)) {
          throw new Error("Cannot execute a statement created by another database adapter");
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
  if (!databaseUrl) {
    throw new Error("PMS database is unavailable. Configure DATABASE_URL.");
  }

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
