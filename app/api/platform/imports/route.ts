/** Validated, tenant-scoped CSV migration with dry-run, atomic commit and safe rollback. */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  getPmsDatabase,
  scopePmsDatabase,
  type PmsPreparedStatement,
} from "../../../../db/pms-database";
import { schemaNotReadyResponse } from "../../../../db/schema-contract";
import {
  assertImportHeaders,
  normalizedImportRow,
  parseCsv,
  validateImportRow,
  type ImportKind,
} from "../../../import-csv";
import {
  principalAccessFailureResponse,
  principalFor,
  ready,
  runtimeBindings,
} from "../../pms/auth";
import { authenticateSupabaseRequest } from "../../../supabase-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("dry_run"),
    kind: z.enum(["ROOM_TYPES", "ROOMS", "GUESTS", "RESERVATIONS"]),
    sourceName: z.string().trim().min(1).max(180),
    csv: z.string().min(1).max(2_000_000),
  }),
  z.object({ action: z.literal("commit"), jobId: z.string().min(3).max(200) }),
  z.object({
    action: z.literal("rollback"),
    jobId: z.string().min(3).max(200),
  }),
]);

function response(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
async function context(request: Request) {
  const root = getPmsDatabase(runtimeBindings);
  try {
    await ready(root);
  } catch (error) {
    const rejected = schemaNotReadyResponse(error);
    if (rejected) return { rejected };
    throw error;
  }
  const principal = await principalFor(request, root);
  if (!principal)
    return { rejected: await principalAccessFailureResponse(request) };
  if (!principal.capabilities.includes("USER_ADMIN"))
    return {
      rejected: response({ error: "데이터 이관 권한이 필요합니다." }, 403),
    };
  const identity = await authenticateSupabaseRequest(request);
  if (!identity)
    return { rejected: response({ error: "로그인이 필요합니다." }, 401) };
  if (
    process.env.PMS_REQUIRE_PLATFORM_MFA !== "false" &&
    identity.assuranceLevel !== "aal2"
  )
    return {
      rejected: response(
        {
          error: "데이터 이관에는 MFA 추가 인증이 필요합니다.",
          code: "MFA_REQUIRED",
        },
        403,
      ),
    };
  return { root, db: scopePmsDatabase(root, principal.propertyId), principal };
}

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > 2_100_000)
    return response({ error: "업로드 파일이 허용 크기를 초과했습니다." }, 413);
  if (
    request.headers.get("origin") &&
    request.headers.get("origin") !== new URL(request.url).origin
  )
    return response({ error: "허용되지 않은 요청 출처입니다." }, 403);
  const resolved = await context(request);
  if ("rejected" in resolved) return resolved.rejected;
  let parsed: z.infer<typeof requestSchema>;
  try {
    parsed = requestSchema.parse(await request.json());
  } catch (error) {
    return response(
      {
        error:
          error instanceof z.ZodError
            ? error.issues.map((issue) => issue.message).join(", ")
            : "요청 형식을 확인하세요.",
      },
      400,
    );
  }
  const { db, principal } = resolved;
  const entitlement = await db
    .prepare(
      "SELECT enabled FROM property_entitlements WHERE property_id=pms_current_property_id() AND feature_key='DATA_IMPORT'",
    )
    .first<{ enabled: boolean }>();
  if (!entitlement?.enabled)
    return response(
      { error: "이 호텔 플랜에는 데이터 이관 기능이 활성화되지 않았습니다." },
      403,
    );
  try {
    if (parsed.action === "dry_run")
      return await dryRun(
        db,
        principal.email,
        parsed.kind,
        parsed.sourceName,
        parsed.csv,
      );
    if (parsed.action === "commit")
      return await commit(db, principal.email, parsed.jobId);
    return await rollback(db, principal.email, parsed.jobId);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "데이터 이관을 완료하지 못했습니다.";
    const conflict =
      /duplicate|unique|foreign key|still referenced|changed after import/iu.test(
        message,
      );
    return response({ error: message }, conflict ? 409 : 400);
  }
}

export async function dryRun(
  db: ReturnType<typeof scopePmsDatabase>,
  actor: string,
  kind: ImportKind,
  sourceName: string,
  csv: string,
) {
  const parsedRows = parseCsv(csv);
  assertImportHeaders(kind, parsedRows[0].data);
  const hash = createHash("sha256")
    .update(kind)
    .update("\0")
    .update(csv)
    .digest("hex");
  const duplicate = await db
    .prepare(
      "SELECT id,status,row_count,valid_count,error_count,summary FROM data_import_jobs WHERE property_id=pms_current_property_id() AND kind=? AND content_hash=? AND mode='DRY_RUN' LIMIT 1",
    )
    .bind(kind, hash)
    .first<Record<string, unknown>>();
  if (duplicate) return response({ ok: true, duplicate: true, job: duplicate });
  const [
    typesResult,
    roomsResult,
    guestsResult,
    reservationsResult,
    plansResult,
  ] = await db.batch([
    db.prepare(
      "SELECT code FROM room_types WHERE property_id=pms_current_property_id()",
    ),
    db.prepare(
      "SELECT number FROM rooms WHERE property_id=pms_current_property_id()",
    ),
    db.prepare(
      "SELECT source_key FROM data_import_entities WHERE property_id=pms_current_property_id() AND entity_type='GUEST'",
    ),
    db.prepare(
      "SELECT confirmation_no FROM reservations WHERE property_id=pms_current_property_id()",
    ),
    db.prepare(
      "SELECT code FROM rate_plans WHERE property_id=pms_current_property_id() AND active",
    ),
  ]);
  const typeCodes = new Set(
      typesResult.results.map((row) => String(row.code).toUpperCase()),
    ),
    roomNumbers = new Set(
      roomsResult.results.map((row) => String(row.number).toUpperCase()),
    ),
    guestKeys = new Set(
      guestsResult.results.map((row) => String(row.source_key)),
    ),
    confirmations = new Set(
      reservationsResult.results.map((row) =>
        String(row.confirmation_no).toUpperCase(),
      ),
    ),
    plans = new Set(
      plansResult.results.map((row) => String(row.code).toUpperCase()),
    );
  const seen = new Set<string>(),
    validated = parsedRows.map((item) => {
      const normalized = normalizedImportRow(kind, item.data) as Record<
          string,
          unknown
        >,
        errors = validateImportRow(kind, normalized);
      const sourceKey = String(
        kind === "ROOM_TYPES"
          ? normalized.code
          : kind === "ROOMS"
            ? normalized.number
            : normalized.external_id || "",
      );
      if (seen.has(sourceKey))
        errors.push("파일 안에 식별자가 중복되었습니다.");
      else seen.add(sourceKey);
      if (kind === "ROOM_TYPES" && typeCodes.has(String(normalized.code)))
        errors.push("이미 존재하는 객실 타입 코드입니다.");
      if (kind === "ROOMS") {
        if (roomNumbers.has(String(normalized.number)))
          errors.push("이미 존재하는 객실 번호입니다.");
        if (!typeCodes.has(String(normalized.room_type_code)))
          errors.push("객실 타입 코드를 찾을 수 없습니다.");
      }
      if (kind === "GUESTS" && guestKeys.has(String(normalized.external_id)))
        errors.push("이미 이관된 고객 외부 ID입니다.");
      if (kind === "RESERVATIONS") {
        if (confirmations.has(String(normalized.confirmation_no)))
          errors.push("이미 존재하는 예약 확인번호입니다.");
        if (!guestKeys.has(String(normalized.guest_external_id)))
          errors.push("먼저 고객 데이터를 이관해야 합니다.");
        if (!typeCodes.has(String(normalized.room_type_code)))
          errors.push("객실 타입 코드를 찾을 수 없습니다.");
        if (!plans.has(String(normalized.rate_plan)))
          errors.push("활성 요금제 코드를 찾을 수 없습니다.");
      }
      return { ...item, normalized, errors };
    });
  const validCount = validated.filter((row) => row.errors.length === 0).length,
    errorCount = validated.length - validCount,
    jobId = `import-${randomUUID()}`,
    now = new Date().toISOString(),
    summary = {
      headers: Object.keys(parsedRows[0].data),
      sampleErrors: validated
        .filter((row) => row.errors.length)
        .slice(0, 20)
        .map((row) => ({ rowNumber: row.rowNumber, errors: row.errors })),
    };
  const statements: PmsPreparedStatement[] = [
    db
      .prepare(
        "INSERT INTO data_import_jobs(id,property_id,kind,mode,status,source_name,content_hash,row_count,valid_count,error_count,summary,created_at,created_by) VALUES (?,pms_current_property_id(),?,'DRY_RUN','VALIDATED',?,?,?,?,?,?,?,?)",
      )
      .bind(
        jobId,
        kind,
        sourceName,
        hash,
        validated.length,
        validCount,
        errorCount,
        summary,
        now,
        actor,
      ),
  ];
  for (const row of validated)
    statements.push(
      db
        .prepare(
          "INSERT INTO data_import_rows(job_id,property_id,row_number,normalized_data,validation_errors) VALUES (?,pms_current_property_id(),?,?,?)",
        )
        .bind(jobId, row.rowNumber, row.normalized, row.errors),
    );
  statements.push(
    db
      .prepare(
        "INSERT INTO audit_logs(id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at) VALUES (?,pms_current_property_id(),?,'DRY_RUN_DATA_IMPORT','data_import',?,NULL,?,?)",
      )
      .bind(
        randomUUID(),
        actor,
        jobId,
        {
          kind,
          rows: validated.length,
          validCount,
          errorCount,
          contentHash: hash,
        },
        now,
      ),
  );
  await db.batch(statements);
  return response(
    {
      ok: true,
      job: {
        id: jobId,
        kind,
        status: "VALIDATED",
        row_count: validated.length,
        valid_count: validCount,
        error_count: errorCount,
        summary,
      },
    },
    201,
  );
}

export async function commit(
  db: ReturnType<typeof scopePmsDatabase>,
  actor: string,
  dryRunJobId: string,
) {
  const job = await db
    .prepare(
      "SELECT * FROM data_import_jobs WHERE id=? AND property_id=pms_current_property_id() AND mode='DRY_RUN' FOR UPDATE",
    )
    .bind(dryRunJobId)
    .first<Record<string, unknown>>();
  if (!job) throw new Error("검증 작업을 찾을 수 없습니다.");
  if (job.status !== "VALIDATED" || Number(job.error_count) > 0)
    throw new Error("오류가 없는 VALIDATED dry-run만 반영할 수 있습니다.");
  const rows = (
    await db
      .prepare(
        "SELECT row_number,normalized_data FROM data_import_rows WHERE job_id=? AND property_id=pms_current_property_id() ORDER BY row_number",
      )
      .bind(dryRunJobId)
      .all<Record<string, unknown>>()
  ).results;
  const kind = String(job.kind) as ImportKind,
    commitId = `import-${randomUUID()}`,
    now = new Date().toISOString();
  const types = (
    await db
      .prepare(
        "SELECT id,code FROM room_types WHERE property_id=pms_current_property_id()",
      )
      .all<{ id: string; code: string }>()
  ).results;
  const typeByCode = new Map(
    types.map((type) => [type.code.toUpperCase(), type.id]),
  );
  const guestMappings = (
    await db
      .prepare(
        "SELECT DISTINCT ON(source_key) source_key,entity_id FROM data_import_entities WHERE property_id=pms_current_property_id() AND entity_type='GUEST' ORDER BY source_key,created_at DESC",
      )
      .all<{ source_key: string; entity_id: string }>()
  ).results;
  const guestBySource = new Map(
    guestMappings.map((item) => [item.source_key, item.entity_id]),
  );
  const statements: PmsPreparedStatement[] = [
    db
      .prepare(
        "INSERT INTO data_import_jobs(id,property_id,kind,mode,status,source_name,content_hash,row_count,valid_count,error_count,summary,created_at,created_by,committed_at) VALUES (?,pms_current_property_id(),?,'COMMIT','COMPLETED',?,?,?,?,0,?,?,?,?)",
      )
      .bind(
        commitId,
        kind,
        String(job.source_name),
        String(job.content_hash),
        rows.length,
        rows.length,
        { sourceDryRunJobId: dryRunJobId },
        now,
        actor,
        now,
      ),
  ];
  for (const item of rows) {
    const row = item.normalized_data as Record<string, unknown>,
      entityId = randomUUID();
    let entityType = "",
      sourceKey = "";
    if (kind === "ROOM_TYPES") {
      entityType = "ROOM_TYPE";
      sourceKey = String(row.code);
      typeByCode.set(sourceKey, entityId);
      statements.push(
        db
          .prepare(
            "INSERT INTO room_types(id,property_id,code,name,base_rate,capacity,description,active,version) VALUES (?,pms_current_property_id(),?,?,?,?,?,true,1)",
          )
          .bind(
            entityId,
            row.code,
            row.name,
            row.base_rate,
            row.capacity,
            row.description,
          ),
      );
      statements.push(
        db
          .prepare(
            "INSERT INTO room_type_website(property_id,room_type_id,published,display_order,marketing_name,short_description,long_description,amenities_json,version,updated_at,updated_by) VALUES (pms_current_property_id(),?,false,0,?,?,?,'[]'::jsonb,1,?,?)",
          )
          .bind(
            entityId,
            row.name,
            row.description,
            row.description,
            now,
            actor,
          ),
      );
      statements.push(
        db
          .prepare(
            "INSERT INTO rate_plan_room_types(property_id,rate_plan_id,room_type_id,base_rate,active,version,updated_at,updated_by) SELECT pms_current_property_id(),id,?,?,true,1,?,? FROM rate_plans WHERE property_id=pms_current_property_id() AND active",
          )
          .bind(entityId, row.base_rate, now, actor),
      );
    } else if (kind === "ROOMS") {
      entityType = "ROOM";
      sourceKey = String(row.number);
      const typeId = typeByCode.get(String(row.room_type_code));
      if (!typeId)
        throw new Error(
          `객실 타입 ${String(row.room_type_code)}이 검증 후 변경되었습니다.`,
        );
      statements.push(
        db
          .prepare(
            "INSERT INTO rooms(id,property_id,room_type_id,number,floor,front_desk_status,housekeeping_status,features,active,version) VALUES (?,pms_current_property_id(),?,?,?,'VACANT','CLEAN',?,true,1)",
          )
          .bind(entityId, typeId, row.number, row.floor, row.features),
      );
    } else if (kind === "GUESTS") {
      entityType = "GUEST";
      sourceKey = String(row.external_id);
      guestBySource.set(sourceKey, entityId);
      statements.push(
        db
          .prepare(
            "INSERT INTO guests(id,property_id,first_name,last_name,email,phone,vip_level,nationality,preferences,created_at) VALUES (?,pms_current_property_id(),?,?,?,?,?,?, '[]'::jsonb,?)",
          )
          .bind(
            entityId,
            row.first_name,
            row.last_name,
            row.email,
            row.phone,
            row.vip_level,
            row.nationality,
            now,
          ),
      );
    } else {
      entityType = "RESERVATION";
      sourceKey = String(row.external_id);
      const typeId = typeByCode.get(String(row.room_type_code)),
        guestId = guestBySource.get(String(row.guest_external_id));
      if (!typeId || !guestId)
        throw new Error("고객 또는 객실 타입 참조가 검증 후 변경되었습니다.");
      statements.push(
        db
          .prepare(
            "INSERT INTO reservations(id,confirmation_no,property_id,guest_id,room_type_id,room_id,arrival_date,departure_date,status,adults,children,source,rate_plan,nightly_rate,eta,notes,version,created_at,updated_at) VALUES (?,?,pms_current_property_id(),?,?,NULL,?::date,?::date,'DUE_IN',?,?,?,?,?::numeric,?::time,?,1,?,?)",
          )
          .bind(
            entityId,
            row.confirmation_no,
            guestId,
            typeId,
            row.arrival_date,
            row.departure_date,
            row.adults,
            row.children,
            row.source,
            row.rate_plan,
            row.nightly_rate,
            row.eta,
            row.notes,
            now,
            now,
          ),
      );
      statements.push(
        db
          .prepare(
            "INSERT INTO folio_windows(id,property_id,reservation_id,window_no,name,payee_type,payee_account_profile_id,status,created_at,created_by,closed_at) VALUES (?,pms_current_property_id(),?,1,'Guest Folio','GUEST',NULL,'OPEN',?,?,NULL)",
          )
          .bind(`fw-${entityId}`, entityId, now, actor),
      );
      statements.push(
        db
          .prepare(
            "INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) SELECT pms_current_property_id(),?,?,day::date FROM generate_series(?::date,(?::date-interval '1 day')::date,interval '1 day') day",
          )
          .bind(entityId, typeId, row.arrival_date, row.departure_date),
      );
    }
    statements.push(
      db
        .prepare(
          "INSERT INTO data_import_entities(job_id,property_id,entity_type,source_key,entity_id,created_at) VALUES (?,pms_current_property_id(),?,?,?,?)",
        )
        .bind(commitId, entityType, sourceKey, entityId, now),
    );
  }
  statements.push(
    db
      .prepare(
        "INSERT INTO audit_logs(id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at) VALUES (?,pms_current_property_id(),?,'COMMIT_DATA_IMPORT','data_import',?,NULL,?,?)",
      )
      .bind(
        randomUUID(),
        actor,
        commitId,
        { kind, rows: rows.length, sourceDryRunJobId: dryRunJobId },
        now,
      ),
  );
  await db.batch(statements);
  return response(
    { ok: true, jobId: commitId, kind, committed: rows.length },
    201,
  );
}

export async function rollback(
  db: ReturnType<typeof scopePmsDatabase>,
  actor: string,
  jobId: string,
) {
  const job = await db
    .prepare(
      "SELECT * FROM data_import_jobs WHERE id=? AND property_id=pms_current_property_id() AND mode='COMMIT' FOR UPDATE",
    )
    .bind(jobId)
    .first<Record<string, unknown>>();
  if (!job) throw new Error("반영 작업을 찾을 수 없습니다.");
  if (job.status !== "COMPLETED")
    throw new Error("COMPLETED 이관 작업만 롤백할 수 있습니다.");
  const entities = (
    await db
      .prepare(
        "SELECT entity_type,entity_id FROM data_import_entities WHERE job_id=? AND property_id=pms_current_property_id()",
      )
      .bind(jobId)
      .all<{ entity_type: string; entity_id: string }>()
  ).results;
  const ids = (type: string) =>
      entities
        .filter((item) => item.entity_type === type)
        .map((item) => item.entity_id),
    now = new Date().toISOString();
  for (const id of ids("RESERVATION")) {
    const changed = await db
      .prepare(
        "SELECT EXISTS(SELECT 1 FROM reservations r WHERE r.id=? AND r.property_id=pms_current_property_id() AND (r.status<>'DUE_IN' OR r.version<>1 OR EXISTS(SELECT 1 FROM folio_entries f WHERE f.reservation_id=r.id))) changed",
      )
      .bind(id)
      .first<{ changed: boolean }>();
    if (changed?.changed)
      throw new Error("예약이 이관 후 변경되어 안전하게 롤백할 수 없습니다.");
  }
  const statements: PmsPreparedStatement[] = [];
  for (const id of ids("RESERVATION")) {
    statements.push(
      db
        .prepare(
          "DELETE FROM reservation_type_nights WHERE reservation_id=? AND property_id=pms_current_property_id()",
        )
        .bind(id),
      db
        .prepare(
          "DELETE FROM folio_windows WHERE reservation_id=? AND property_id=pms_current_property_id()",
        )
        .bind(id),
      db
        .prepare(
          "DELETE FROM reservations WHERE id=? AND property_id=pms_current_property_id()",
        )
        .bind(id),
    );
  }
  for (const id of ids("ROOM"))
    statements.push(
      db
        .prepare(
          "DELETE FROM rooms WHERE id=? AND property_id=pms_current_property_id()",
        )
        .bind(id),
    );
  for (const id of ids("GUEST"))
    statements.push(
      db
        .prepare(
          "DELETE FROM guests WHERE id=? AND property_id=pms_current_property_id()",
        )
        .bind(id),
    );
  for (const id of ids("ROOM_TYPE")) {
    statements.push(
      db
        .prepare(
          "DELETE FROM rate_plan_room_types WHERE room_type_id=? AND property_id=pms_current_property_id()",
        )
        .bind(id),
      db
        .prepare(
          "DELETE FROM room_type_website WHERE room_type_id=? AND property_id=pms_current_property_id()",
        )
        .bind(id),
      db
        .prepare(
          "DELETE FROM room_types WHERE id=? AND property_id=pms_current_property_id()",
        )
        .bind(id),
    );
  }
  statements.push(
    db
      .prepare(
        "DELETE FROM data_import_entities WHERE job_id=? AND property_id=pms_current_property_id()",
      )
      .bind(jobId),
    db
      .prepare(
        "UPDATE data_import_jobs SET status='ROLLED_BACK',rolled_back_at=? WHERE id=? AND property_id=pms_current_property_id()",
      )
      .bind(now, jobId),
    db
      .prepare(
        "INSERT INTO audit_logs(id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at) VALUES (?,pms_current_property_id(),?,'ROLLBACK_DATA_IMPORT','data_import',?,NULL,?,?)",
      )
      .bind(randomUUID(), actor, jobId, { entities: entities.length }, now),
  );
  await db.batch(statements);
  return response({ ok: true, jobId, rolledBack: entities.length });
}
