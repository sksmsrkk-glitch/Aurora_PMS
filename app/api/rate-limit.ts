/** Database-backed rate limiting shared by every serverless instance. */
import { createHmac } from "node:crypto";
import { getPmsDatabase, type PmsDatabase } from "../../db/pms-database";

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfter: number;
};

function signingSecret() {
  const configured = process.env.PMS_RATE_LIMIT_SECRET || "";
  if (configured.length >= 32) return configured;
  if (process.env.NODE_ENV === "production") throw new Error("PMS_RATE_LIMIT_SECRET must contain at least 32 characters");
  // This fallback is intentionally development-only; production fails closed so
  // client addresses are never persisted with a predictable digest.
  return "aurora-local-rate-limit-development-only";
}

export function clientAddress(request: Request) {
  // Vercel overwrites x-forwarded-for and exposes x-vercel-forwarded-for as the
  // proxy-safe client address. Outside Vercel, forwarding headers are trusted only
  // when an operator explicitly declares a trusted proxy topology.
  if (process.env.VERCEL) {
    return (request.headers.get("x-vercel-forwarded-for") || request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  }
  if (process.env.PMS_TRUST_PROXY === "true") {
    return (request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown").split(",")[0].trim();
  }
  return "untrusted-direct-client";
}

export async function consumeRateLimit(
  request: Request,
  scope: string,
  limit: number,
  windowMs: number,
  identity = "anonymous",
  database?: PmsDatabase,
): Promise<RateLimitResult> {
  if (!/^[a-z0-9:_-]{2,64}$/u.test(scope) || !Number.isInteger(limit) || limit < 1 || windowMs < 1_000) {
    throw new Error("Invalid rate-limit policy");
  }
  const now = Date.now();
  const windowStartMs = Math.floor(now / windowMs) * windowMs;
  const windowStart = new Date(windowStartMs).toISOString();
  const expiresAt = new Date(windowStartMs + windowMs * 2).toISOString();
  const keyHash = createHmac("sha256", signingSecret())
    .update(`${scope}\n${identity}\n${clientAddress(request)}`)
    .digest("hex");
  const db = database || getPmsDatabase({ DATABASE_URL: process.env.DATABASE_URL });

  // One UPSERT is the concurrency boundary: every Vercel instance increments the
  // same row and receives the authoritative count from PostgreSQL/D1.
  const counter = await db.prepare(
    "INSERT INTO api_rate_limits(scope,key_hash,window_start,count,expires_at) VALUES (?,?,?,1,?) ON CONFLICT(scope,key_hash,window_start) DO UPDATE SET count=api_rate_limits.count+1,expires_at=excluded.expires_at RETURNING count",
  ).bind(scope,keyHash,windowStart,expiresAt).first<{count:number}>();
  if (!counter) throw new Error("Rate-limit counter was not persisted");
  const count = Number(counter.count);

  // Deterministic sampling bounds table growth without adding a cleanup write to
  // every request. Expiry is not part of the authorization decision.
  if (keyHash.startsWith("00")) await db.prepare("DELETE FROM api_rate_limits WHERE expires_at<?").bind(new Date(now).toISOString()).run();
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0,limit-count),
    retryAfter: Math.max(1,Math.ceil((windowStartMs+windowMs-now)/1000)),
  };
}

export function rateLimitHeaders(result: RateLimitResult) {
  return {
    "Retry-After": String(result.retryAfter),
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
  };
}
