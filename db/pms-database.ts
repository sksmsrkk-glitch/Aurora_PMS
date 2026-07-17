/** Unified prepared-statement adapter for Supabase RPC, PostgreSQL and D1. */
import postgres from "postgres";

export type PmsDialect = "d1" | "postgres";

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
  readonly dialect: PmsDialect;
  prepare(query: string): PmsPreparedStatement;
  batch<T = Record<string, unknown>>(statements: PmsPreparedStatement[]): Promise<PmsResult<T>[]>;
}

export function scopePmsDatabase(database: PmsDatabase, propertyId: string): PmsDatabase {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(propertyId)) throw new Error("Invalid property scope");
  const quotedPropertyId = `'${propertyId}'`;
  return {
    dialect: database.dialect,
    prepare(query: string) {
      return database.prepare(query.replaceAll("'prop-seoul'", quotedPropertyId));
    },
    batch<T = Record<string, unknown>>(statements: PmsPreparedStatement[]) {
      return database.batch<T>(statements);
    },
  };
}

export type PmsRuntimeBindings = {
  DB?: D1Database;
  DATABASE_URL?: string;
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
};

type PostgresExecutor = postgres.Sql | postgres.TransactionSql;

function replaceQuestionPlaceholders(query: string) {
  let index = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let output = "";

  for (let position = 0; position < query.length; position += 1) {
    const character = query[position];
    const next = query[position + 1];

    if (character === "'" && !doubleQuoted) {
      output += character;
      if (singleQuoted && next === "'") {
        output += next;
        position += 1;
      } else {
        singleQuoted = !singleQuoted;
      }
      continue;
    }

    if (character === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      output += character;
      continue;
    }

    if (character === "?" && !singleQuoted && !doubleQuoted) {
      index += 1;
      output += `$${index}`;
      continue;
    }

    output += character;
  }

  return output;
}

export function toPostgresSql(query: string) {
  let sql = query.trim().replace(/;\s*$/u, "");
  const ignoresConflict = /\bINSERT\s+OR\s+IGNORE\s+INTO\b/iu.test(sql);

  sql = sql.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/giu, "INSERT INTO");
  sql = sql.replace(
    /date\(\(SELECT business_date FROM properties WHERE id='prop-seoul'\),\s*'\+13 day'\)/giu,
    "to_char(((SELECT business_date FROM properties WHERE id='prop-seoul')::date + INTERVAL '13 day'), 'YYYY-MM-DD')",
  );
  sql = sql.replace(
    /date\(stay_date,\s*'\+1 day'\)/giu,
    "to_char(stay_date::date + INTERVAL '1 day', 'YYYY-MM-DD')",
  );
  sql = sql.replace(
    /julianday\(r\.departure_date\)\s*-\s*julianday\(r\.arrival_date\)/giu,
    "(r.departure_date::date - r.arrival_date::date)",
  );
  sql = replaceQuestionPlaceholders(sql);
  sql = sql.replace(
    /WITH RECURSIVE dates\(stay_date\) AS \(SELECT \$1 UNION ALL/iu,
    "WITH RECURSIVE dates(stay_date) AS (SELECT $1::text UNION ALL",
  );

  if (ignoresConflict && !/\bON\s+CONFLICT\b/iu.test(sql)) {
    sql += " ON CONFLICT DO NOTHING";
  }

  return sql;
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
}

class PostgresDatabase implements PmsDatabase {
  readonly dialect = "postgres" as const;

  constructor(private readonly client: postgres.Sql) {}

  prepare(query: string) {
    return new PostgresPreparedStatement(this, query);
  }

  async execute<T>(query: string, values: unknown[], executor: PostgresExecutor = this.client): Promise<PmsResult<T>> {
    const rows = await executor.unsafe(toPostgresSql(query), values as never[]);
    const resultRows = Array.from(rows) as T[];
    const changes = typeof rows.count === "number" ? rows.count : resultRows.length;
    return { results: resultRows, success: true, meta: { changes } };
  }

  async batch<T = Record<string, unknown>>(statements: PmsPreparedStatement[]) {
    if (!statements.length) return [];

    return this.client.begin(async (transaction) => {
      const results: PmsResult<T>[] = [];
      for (const statement of statements) {
        if (!(statement instanceof PostgresPreparedStatement)) {
          throw new Error("Cannot mix D1 and PostgreSQL statements in one batch");
        }
        results.push(await statement.executeWith<T>(transaction));
      }
      return results;
    });
  }
}

type SupabaseRpcResult<T> = { results?: T[]; changes?: number };

class SupabasePreparedStatement implements PmsPreparedStatement {
  constructor(
    private readonly database: SupabaseHttpDatabase,
    readonly query: string,
    readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new SupabasePreparedStatement(this.database,this.query,values);
  }

  async first<T = Record<string, unknown>>() {
    const result=await this.database.execute<T>(this.query,this.values);
    return result.results[0] ?? null;
  }

  all<T = Record<string, unknown>>() {
    return this.database.execute<T>(this.query,this.values);
  }

  run<T = Record<string, unknown>>() {
    return this.database.execute<T>(this.query,this.values);
  }
}

class SupabaseHttpDatabase implements PmsDatabase {
  readonly dialect = "postgres" as const;

  constructor(private readonly url:string,private readonly secretKey:string) {}

  prepare(query:string) {
    return new SupabasePreparedStatement(this,query);
  }

  private async rpc<T>(name:"pms_execute"|"pms_batch",body:Record<string,unknown>):Promise<T> {
    const response=await fetch(`${this.url.replace(/\/$/u,"")}/rest/v1/rpc/${name}`,{
      method:"POST",
      headers:{
        apikey:this.secretKey,
        "content-type":"application/json",
        accept:"application/json",
        "x-client-info":"aurora-pms-worker/1.0",
      },
      body:JSON.stringify(body,(_key,value)=>value===undefined?null:value),
    });
    if(!response.ok){
      let message=`Supabase Data API request failed (${response.status})`;
      try {
        const error=await response.json() as {message?:string;details?:string;hint?:string};
        message=[error.message,error.details,error.hint].filter(Boolean).join(" · ")||message;
      } catch { /* Keep the sanitized HTTP status message. */ }
      throw new Error(message);
    }
    return await response.json() as T;
  }

  async execute<T>(query:string,values:unknown[]):Promise<PmsResult<T>> {
    const payload=await this.rpc<SupabaseRpcResult<T>>("pms_execute",{p_sql:toPostgresSql(query),p_values:values});
    const results=Array.isArray(payload.results)?payload.results:[];
    return {results,success:true,meta:{changes:Number(payload.changes??results.length)}};
  }

  async batch<T = Record<string, unknown>>(statements:PmsPreparedStatement[]) {
    if(!statements.length)return [];
    const payload=statements.map((statement)=>{
      if(!(statement instanceof SupabasePreparedStatement))throw new Error("Cannot mix database statement implementations in one batch");
      return {sql:toPostgresSql(statement.query),values:statement.values};
    });
    const response=await this.rpc<SupabaseRpcResult<T>[]>("pms_batch",{p_statements:payload});
    return response.map((item)=>{
      const results=Array.isArray(item.results)?item.results:[];
      return {results,success:true as const,meta:{changes:Number(item.changes??results.length)}};
    });
  }
}

class D1PreparedStatementAdapter implements PmsPreparedStatement {
  constructor(private readonly statement: D1PreparedStatement) {}

  bind(...values: unknown[]) {
    return new D1PreparedStatementAdapter(this.statement.bind(...values));
  }

  first<T = Record<string, unknown>>() {
    return this.statement.first<T>();
  }

  async all<T = Record<string, unknown>>() {
    const result = await this.statement.all<T>();
    return {
      results: result.results ?? [],
      success: true as const,
      meta: { changes: Number(result.meta?.changes ?? 0) },
    };
  }

  async run<T = Record<string, unknown>>() {
    const result = await this.statement.run<T>();
    return {
      results: result.results ?? [],
      success: true as const,
      meta: { changes: Number(result.meta?.changes ?? 0) },
    };
  }

  get native() {
    return this.statement;
  }
}

class D1DatabaseAdapter implements PmsDatabase {
  readonly dialect = "d1" as const;

  constructor(private readonly database: D1Database) {}

  prepare(query: string) {
    return new D1PreparedStatementAdapter(this.database.prepare(query));
  }

  async batch<T = Record<string, unknown>>(statements: PmsPreparedStatement[]) {
    const native = statements.map((statement) => {
      if (!(statement instanceof D1PreparedStatementAdapter)) {
        throw new Error("Cannot mix PostgreSQL and D1 statements in one batch");
      }
      return statement.native;
    });
    const results = await this.database.batch<T>(native);
    return results.map((result) => ({
      results: result.results ?? [],
      success: true as const,
      meta: { changes: Number(result.meta?.changes ?? 0) },
    }));
  }
}

let postgresClient: postgres.Sql | null = null;
let postgresUrl: string | null = null;

function processDatabaseUrl() {
  if (typeof process === "undefined") return undefined;
  return process.env.DATABASE_URL;
}

function processSetting(name:"SUPABASE_URL"|"SUPABASE_SECRET_KEY") {
  if (typeof process === "undefined") return undefined;
  return process.env[name];
}

export function getPmsDatabase(bindings: PmsRuntimeBindings): PmsDatabase {
  const supabaseUrl=bindings.SUPABASE_URL||processSetting("SUPABASE_URL");
  const supabaseSecretKey=bindings.SUPABASE_SECRET_KEY||processSetting("SUPABASE_SECRET_KEY");
  if(supabaseUrl&&supabaseSecretKey)return new SupabaseHttpDatabase(supabaseUrl,supabaseSecretKey);

  const databaseUrl = bindings.DATABASE_URL || processDatabaseUrl();
  if (databaseUrl) {
    if (!postgresClient || postgresUrl !== databaseUrl) {
      postgresClient = postgres(databaseUrl, {
        max: 6,
        prepare: false,
        connect_timeout: 12,
        idle_timeout: 20,
        max_lifetime: 60 * 15,
        ssl: "require",
        transform: { undefined: null },
      });
      postgresUrl = databaseUrl;
    }
    return new PostgresDatabase(postgresClient);
  }

  if (bindings.DB) return new D1DatabaseAdapter(bindings.DB);
  throw new Error("PMS database is unavailable. Configure DATABASE_URL or the DB binding.");
}
