/** Durable multi-property worker for outbox, ARI, DNS, backup and usage jobs. */
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { lookup, resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
import {
  getPmsDatabase,
  scopePmsDatabase,
  type WorkerJob,
} from "../../../../db/pms-database";
import { verifyPmsSchemaContract } from "../../../../db/schema-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 55;

function authorized(request: Request) {
  const expected = process.env.CRON_SECRET || "",
    supplied = (request.headers.get("authorization") || "").replace(
      /^Bearer\s+/iu,
      "",
    );
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected),
    b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value === "string")
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  return {};
}
function outboundUrl(value: string) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    isIP(host) ||
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    throw new Error("Outbound endpoint is not allowed");
  const allowlist = (process.env.AURORA_OUTBOUND_HOST_ALLOWLIST || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (
    allowlist.length &&
    !allowlist.some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`),
    )
  )
    throw new Error("Outbound endpoint is not allow-listed");
  return url;
}
function privateAddress(value: string) {
  const address = value.toLowerCase();
  if (
    address === "::1" ||
    address === "::" ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    /^fe[89ab]/u.test(address)
  )
    return true;
  const ipv4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  const octets = ipv4.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
async function postJson(
  urlValue: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const url = outboundUrl(urlValue),
    controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 10_000);
  try {
    // Validate every current A/AAAA answer. Production should additionally route
    // outbound traffic through an egress proxy, which also defeats DNS rebinding.
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (
      !addresses.length ||
      addresses.some((item) => privateAddress(item.address))
    )
      throw new Error("Outbound endpoint resolves to a private network");
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Aurora-PMS-Worker/1.0",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function processJob(job: WorkerJob) {
  const db = scopePmsDatabase(
      getPmsDatabase({ DATABASE_URL: process.env.DATABASE_URL }),
      job.property_id,
    ),
    payload = object(job.payload),
    now = new Date().toISOString();
  if (job.job_type === "OUTBOX_WEBHOOK") {
    const event = await db
      .prepare(
        "SELECT * FROM outbox_events WHERE id=? AND property_id=pms_current_property_id()",
      )
      .bind(job.source_id)
      .first<Record<string, unknown>>();
    if (!event) throw new Error("Outbox source is missing");
    const hooks = (
      await db
        .prepare(
          "SELECT * FROM property_webhooks WHERE property_id=pms_current_property_id() AND active ORDER BY id",
        )
        .all<Record<string, unknown>>()
    ).results;
    const envelope = {
        id: event.id,
        topic: event.topic,
        aggregateType: event.aggregate_type,
        aggregateId: event.aggregate_id,
        propertyId: job.property_id,
        occurredAt: event.created_at,
        data: event.payload_json,
      },
      serialized = JSON.stringify(envelope);
    for (const hook of hooks) {
      const events = Array.isArray(hook.event_types) ? hook.event_types : [];
      if (!events.includes("*") && !events.includes(event.topic)) continue;
      const secret = process.env[String(hook.secret_reference)];
      if (!secret)
        throw new Error(
          `Webhook secret ${String(hook.secret_reference)} is unavailable`,
        );
      const signature = createHmac("sha256", secret)
        .update(serialized)
        .digest("hex");
      const response = await postJson(String(hook.endpoint_url), envelope, {
        "X-Aurora-Signature": `sha256=${signature}`,
        "X-Aurora-Event-Id": String(event.id),
      });
      if (!response.ok)
        throw Object.assign(new Error(`Webhook returned ${response.status}`), {
          httpStatus: response.status,
        });
    }
    await db
      .prepare(
        "UPDATE outbox_events SET status='PUBLISHED',attempts=attempts+1,published_at=? WHERE id=? AND property_id=pms_current_property_id()",
      )
      .bind(now, job.source_id)
      .run();
    return;
  }
  if (job.job_type === "ARI_DELIVERY") {
    const update = await db
      .prepare(
        "SELECT a.*,c.provider,c.external_property_id,m.external_room_type_id,m.external_rate_plan_id FROM ari_updates a JOIN channel_connections c ON c.id=a.connection_id JOIN channel_mappings m ON m.id=a.mapping_id WHERE a.id=? AND a.property_id=pms_current_property_id() AND c.status='ACTIVE'",
      )
      .bind(job.source_id)
      .first<Record<string, unknown>>();
    if (!update) throw new Error("ARI source or active channel is missing");
    const provider = String(update.provider)
        .toUpperCase()
        .replace(/[^A-Z0-9]/gu, "_"),
      endpoint = process.env[`AURORA_CHANNEL_${provider}_ENDPOINT`],
      secret = process.env[`AURORA_CHANNEL_${provider}_SECRET`];
    if (!endpoint || !secret)
      throw new Error(`ARI adapter ${provider} is not configured`);
    const response = await postJson(
      endpoint,
      {
        propertyId: update.external_property_id,
        roomTypeId: update.external_room_type_id,
        ratePlanId: update.external_rate_plan_id,
        stayDate: update.stay_date,
        revision: update.revision,
        availability: update.available,
        closed: update.closed,
        minStay: update.min_stay,
        cta: update.close_to_arrival,
        ctd: update.close_to_departure,
        rate: update.rate,
        currency: update.currency,
      },
      {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": String(update.id),
      },
    );
    if (!response.ok)
      throw Object.assign(
        new Error(`ARI adapter returned ${response.status}`),
        { httpStatus: response.status },
      );
    await db.batch([
      db
        .prepare(
          "UPDATE ari_updates SET status='SENT',attempts=attempts+1,sent_at=?,last_error=NULL WHERE id=? AND property_id=pms_current_property_id()",
        )
        .bind(now, job.source_id),
      db
        .prepare(
          "UPDATE channel_connections SET last_sync_at=?,updated_at=? WHERE id=? AND property_id=pms_current_property_id()",
        )
        .bind(now, now, update.connection_id),
    ]);
    return;
  }
  if (job.job_type === "DOMAIN_VERIFY") {
    const domain = await db
      .prepare(
        "SELECT * FROM property_domains WHERE id=? AND property_id=pms_current_property_id()",
      )
      .bind(job.source_id)
      .first<Record<string, unknown>>();
    if (!domain) throw new Error("Domain source is missing");
    const hostname = String(domain.hostname),
      records = await resolveTxt(`_aurora.${hostname}`),
      tokens = records
        .map((parts) => parts.join(""))
        .filter((value) => value.startsWith("aurora-verification="))
        .map((value) => value.slice("aurora-verification=".length));
    if (
      !tokens.some(
        (token) =>
          createHash("sha256").update(token).digest("hex") ===
          domain.verification_token_hash,
      )
    )
      throw new Error("DNS verification token is not published yet");
    await db
      .prepare(
        "UPDATE property_domains SET status='ACTIVE',verified_at=?,updated_at=? WHERE id=? AND property_id=pms_current_property_id()",
      )
      .bind(now, now, job.source_id)
      .run();
    return;
  }
  if (job.job_type === "BACKUP_VERIFY") {
    const run = await db
      .prepare(
        "SELECT * FROM backup_runs WHERE id=? AND property_id=pms_current_property_id()",
      )
      .bind(job.source_id)
      .first<Record<string, unknown>>();
    if (!run) throw new Error("Backup request is missing");
    const endpoint = process.env.AURORA_BACKUP_ORCHESTRATOR_URL,
      secret = process.env.AURORA_BACKUP_ORCHESTRATOR_SECRET;
    if (!endpoint || !secret)
      throw new Error("Backup orchestrator is not configured");
    await db
      .prepare(
        "UPDATE backup_runs SET status='RUNNING',started_at=COALESCE(started_at,?) WHERE id=? AND property_id=pms_current_property_id()",
      )
      .bind(now, job.source_id)
      .run();
    const result = await postJson(
      endpoint,
      { requestId: run.id, propertyId: job.property_id, type: run.backup_type },
      { Authorization: `Bearer ${secret}`, "Idempotency-Key": String(run.id) },
    );
    if (!result.ok)
      throw Object.assign(
        new Error(`Backup orchestrator returned ${result.status}`),
        { httpStatus: result.status },
      );
    const receipt = object(await result.json());
    if (!receipt.storageReference || !receipt.checksum)
      throw new Error("Backup receipt is incomplete");
    await db
      .prepare(
        "UPDATE backup_runs SET status='VERIFIED',storage_reference=?,checksum=?,size_bytes=?,completed_at=?,verified_at=?,error_message=NULL WHERE id=? AND property_id=pms_current_property_id()",
      )
      .bind(
        String(receipt.storageReference),
        String(receipt.checksum),
        Number(receipt.sizeBytes || 0),
        now,
        now,
        job.source_id,
      )
      .run();
    return;
  }
  if (job.job_type === "USAGE_ROLLUP") {
    const usageDate = String(
      payload.usageDate ||
        new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    );
    await db
      .prepare(
        `INSERT INTO property_usage_daily(property_id,usage_date,active_rooms,active_users,reservations_created,api_requests,report_exports,storage_bytes,calculated_at)
      SELECT pms_current_property_id(),?::date,(SELECT COUNT(*) FROM rooms WHERE property_id=pms_current_property_id() AND active),(SELECT COUNT(*) FROM role_assignments WHERE property_id=pms_current_property_id() AND active),(SELECT COUNT(*) FROM reservations WHERE property_id=pms_current_property_id() AND created_at>=?::date AND created_at<(?::date+1)),0,(SELECT COUNT(*) FROM report_exports WHERE property_id=pms_current_property_id() AND created_at>=?::date AND created_at<(?::date+1)),0,clock_timestamp()
      ON CONFLICT(property_id,usage_date) DO UPDATE SET active_rooms=excluded.active_rooms,active_users=excluded.active_users,reservations_created=excluded.reservations_created,api_requests=excluded.api_requests,report_exports=excluded.report_exports,calculated_at=excluded.calculated_at`,
      )
      .bind(usageDate, usageDate, usageDate, usageDate, usageDate)
      .run();
    return;
  }
  throw new Error(`Unsupported job type ${job.job_type}`);
}

async function run(request: Request) {
  if (!authorized(request))
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const root = getPmsDatabase({ DATABASE_URL: process.env.DATABASE_URL });
  await verifyPmsSchemaContract(root);
  const usageDate = new Date(Date.now() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  await root.enqueueUsageRollups(usageDate);
  const workerId = `vercel:${process.env.VERCEL_REGION || "local"}:${randomUUID().slice(0, 8)}`,
    jobs = await root.claimWorkerJobs(
      workerId,
      Math.min(
        20,
        Math.max(1, Number(process.env.AURORA_WORKER_BATCH_SIZE || 10)),
      ),
    ),
    results = [];
  for (const job of jobs) {
    const started = Date.now();
    try {
      await processJob(job);
      await root.finishWorkerJob({
        jobId: job.id,
        workerId,
        outcome: "SUCCEEDED",
        durationMs: Date.now() - started,
      });
      results.push({ id: job.id, status: "SUCCEEDED" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error),
        httpStatus =
          typeof error === "object" && error && "httpStatus" in error
            ? Number((error as { httpStatus: unknown }).httpStatus)
            : undefined,
        outcome = job.attempts >= job.max_attempts ? "DEAD" : "RETRY";
      await root.finishWorkerJob({
        jobId: job.id,
        workerId,
        outcome,
        durationMs: Date.now() - started,
        httpStatus,
        errorCode: error instanceof Error ? error.name : "WORKER_ERROR",
        errorMessage: message,
      });
      if (outcome === "DEAD") {
        const scoped = scopePmsDatabase(root, job.property_id);
        await scoped
          .prepare(
            "INSERT INTO service_incidents(id,property_id,component,severity,status,summary,started_at,metadata) VALUES (?,pms_current_property_id(),?,'CRITICAL','OPEN',?,clock_timestamp(),?) ON CONFLICT(id) DO UPDATE SET status='OPEN',summary=excluded.summary,metadata=excluded.metadata,resolved_at=NULL",
          )
          .bind(
            `incident-${job.id}`,
            job.job_type,
            `비동기 작업이 DLQ로 이동했습니다: ${message.slice(0, 300)}`,
            { jobId: job.id, attempts: job.attempts },
          )
          .run();
      }
      results.push({ id: job.id, status: outcome, error: message });
    }
  }
  return Response.json(
    { ok: true, workerId, claimed: jobs.length, results },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request) {
  return run(request);
}
export async function POST(request: Request) {
  return run(request);
}
