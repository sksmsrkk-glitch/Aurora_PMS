import { createHash } from "node:crypto";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { cookies } from "next/headers";

const ACCESS_COOKIE = "aurora-pms-access";
const REFRESH_COOKIE = "aurora-pms-refresh";
const TOKEN_CACHE_TTL_MS = 30_000;

export type SupabaseIdentity = {
  id: string;
  email: string;
  displayName: string;
};

type AuthSession = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: Record<string, unknown>;
};

const identityCache = new Map<string, { expires: number; identity: SupabaseIdentity }>();
const identityInflight = new Map<string, Promise<SupabaseIdentity | null>>();
let remoteJwkSet: ReturnType<typeof createRemoteJWKSet> | null = null;

function authConfiguration() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/u, "");
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) throw new Error("Supabase Auth configuration is unavailable");
  return { url, secret };
}

function identityFromUser(user: Record<string, unknown>): SupabaseIdentity | null {
  const id = typeof user.id === "string" ? user.id : "";
  const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
  if (!id || !email) return null;
  const metadata = user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata as Record<string, unknown> : {};
  const displayName = [metadata.full_name, metadata.name, metadata.display_name].find((value) => typeof value === "string" && value.trim());
  return { id, email, displayName: typeof displayName === "string" ? displayName.trim() : email };
}

function projectJwks() {
  if (remoteJwkSet) return remoteJwkSet;
  const { url } = authConfiguration();
  remoteJwkSet = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`), {
    cacheMaxAge: 10 * 60_000,
    cooldownDuration: 30_000,
    timeoutDuration: 5_000,
  });
  return remoteJwkSet;
}

async function locallyVerifiedIdentity(accessToken: string) {
  const { url, secret } = authConfiguration();
  try {
    const header = decodeProtectedHeader(accessToken);
    if (!["ES256", "RS256"].includes(String(header.alg))) return null;
    const { payload } = await jwtVerify(accessToken, projectJwks(), {
      issuer: `${url}/auth/v1`,
      audience: "authenticated",
      algorithms: ["ES256", "RS256"],
      clockTolerance: 5,
    });
    if (payload.role !== "authenticated" || typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    return identityFromUser({ id: payload.sub, email: payload.email, user_metadata: payload.user_metadata });
  } catch {
    // A network or key-rotation failure can fall back to Auth's authoritative user endpoint.
    return remoteVerifiedIdentity(accessToken, url, secret);
  }
}

async function remoteVerifiedIdentity(accessToken: string, configuredUrl?: string, configuredSecret?: string) {
  const configuration = configuredUrl && configuredSecret ? { url: configuredUrl, secret: configuredSecret } : authConfiguration();
  const response = await fetch(`${configuration.url}/auth/v1/user`, {
    headers: { apikey: configuration.secret, authorization: `Bearer ${accessToken}`, "x-client-info": "aurora-pms/1.0" },
    cache: "no-store",
  });
  if (!response.ok) return null;
  return identityFromUser(await response.json() as Record<string, unknown>);
}

async function resolvedIdentity(accessToken: string) {
  try {
    const header = decodeProtectedHeader(accessToken);
    if (["ES256", "RS256"].includes(String(header.alg))) return locallyVerifiedIdentity(accessToken);
  } catch { return null; }
  return remoteVerifiedIdentity(accessToken);
}

async function userForAccessToken(accessToken: string) {
  const cacheKey = createHash("sha256").update(accessToken).digest("base64url");
  const cached = identityCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expires > now) return cached.identity;
  const inflight = identityInflight.get(cacheKey);
  if (inflight) return inflight;
  if (identityCache.size > 500) {
    for (const [key, value] of identityCache) if (value.expires <= now) identityCache.delete(key);
    if (identityCache.size > 500) identityCache.clear();
  }
  const verification = resolvedIdentity(accessToken);
  identityInflight.set(cacheKey, verification);
  try {
    const identity = await verification;
    if (identity) identityCache.set(cacheKey, { expires: now + TOKEN_CACHE_TTL_MS, identity });
    return identity;
  } finally {
    identityInflight.delete(cacheKey);
  }
}

async function refreshSession(refreshToken: string) {
  const { url, secret } = authConfiguration();
  const response = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: secret, "content-type": "application/json", "x-client-info": "aurora-pms/1.0" },
    body: JSON.stringify({ refresh_token: refreshToken }),
    cache: "no-store",
  });
  if (!response.ok) return null;
  return await response.json() as AuthSession;
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/iu);
  return match?.[1]?.trim() || null;
}

export async function authenticateSupabaseRequest(request: Request): Promise<SupabaseIdentity | null> {
  const bearer = bearerToken(request);
  const cookieStore = await cookies();
  const accessToken = bearer || cookieStore.get(ACCESS_COOKIE)?.value || null;
  if (accessToken) {
    const identity = await userForAccessToken(accessToken);
    if (identity) return identity;
  }
  if (bearer) return null;
  const refreshToken = cookieStore.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) return null;
  const session = await refreshSession(refreshToken);
  if (!session) {
    clearSessionCookies(cookieStore);
    return null;
  }
  setSessionCookies(cookieStore, session);
  return identityFromUser(session.user);
}

export async function signInWithPassword(email: string, password: string) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/u.test(normalizedEmail) || password.length < 8) return null;
  const { url, secret } = authConfiguration();
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: secret, "content-type": "application/json", "x-client-info": "aurora-pms/1.0" },
    body: JSON.stringify({ email: normalizedEmail, password }),
    cache: "no-store",
  });
  if (!response.ok) return null;
  const session = await response.json() as AuthSession;
  const identity = identityFromUser(session.user);
  if (!identity) return null;
  setSessionCookies(await cookies(), session);
  return identity;
}

type MutableCookieStore = Awaited<ReturnType<typeof cookies>>;

function setSessionCookies(cookieStore: MutableCookieStore, session: AuthSession) {
  const common = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/" };
  cookieStore.set(ACCESS_COOKIE, session.access_token, { ...common, maxAge: Math.max(60, Number(session.expires_in || 3600) - 30) });
  cookieStore.set(REFRESH_COOKIE, session.refresh_token, { ...common, maxAge: 60 * 60 * 24 * 30 });
}

function clearSessionCookies(cookieStore: MutableCookieStore) {
  const common = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge: 0 };
  cookieStore.set(ACCESS_COOKIE, "", common);
  cookieStore.set(REFRESH_COOKIE, "", common);
}

export async function signOut() {
  clearSessionCookies(await cookies());
}
