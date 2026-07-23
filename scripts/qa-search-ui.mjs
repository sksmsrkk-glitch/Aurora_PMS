/**
 * Real browser search QA with a loopback-only PostgreSQL database and a tiny
 * deterministic Supabase Auth double. It exercises the production login route,
 * HttpOnly session cookies, tenant RBAC, client hydration, search, reports, and
 * logout without using a shared staging/production account.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import postgres from "postgres";

const databaseUrl =
  process.env.SEARCH_E2E_DATABASE_URL ||
  process.env.TEST_DATABASE_URL ||
  "";
if (!databaseUrl) throw new Error("SEARCH_E2E_DATABASE_URL is required");
const databaseTarget = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "::1"].includes(databaseTarget.hostname)) {
  throw new Error("Search UI QA is restricted to a loopback PostgreSQL");
}

const appPort = Number(process.env.SEARCH_E2E_APP_PORT) || 3100;
const authPort = Number(process.env.SEARCH_E2E_AUTH_PORT) || 3101;
// Chromium treats localhost as a potentially trustworthy origin and therefore
// accepts the production Secure session cookies over loopback HTTP. 127.0.0.1
// does not receive that exception consistently on Linux and caused a false
// login loop in CI after the API had already returned 200.
const baseUrl = `http://localhost:${appPort}`;
const authUrl = `http://127.0.0.1:${authPort}`;
const email = "search.e2e@talos.local";
const password = "TalosE2E-Only!";
const authUserId = "92027939-7216-4aed-bc77-821de2285019";
const assignmentId = "role-search-browser-e2e";
const authSecret = "search-e2e-auth-secret-with-at-least-32-characters";
const sessionUser = {
  id: authUserId,
  email,
  user_metadata: { display_name: "검색 QA 관리자" },
};
const accessToken = [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url",
  ),
  Buffer.from(
    JSON.stringify({
      sub: authUserId,
      email,
      role: "authenticated",
      aal: "aal1",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url"),
  "search-e2e-signature",
].join(".");
const session = {
  access_token: accessToken,
  refresh_token: "search-e2e-refresh-token",
  expires_in: 3600,
  user: sessionUser,
};
const sql = postgres(databaseUrl, {
  max: 2,
  prepare: false,
  ssl: false,
  idle_timeout: 2,
});
const appLogs = [];
let appProcess;
let authServer;
let browser;
let cleaning = false;

function json(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

async function startAuthServer() {
  authServer = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", authUrl);
    if (
      request.method === "POST" &&
      url.pathname === "/auth/v1/token" &&
      url.searchParams.get("grant_type") === "password"
    ) {
      const body = await requestBody(request);
      if (body.email === email && body.password === password) {
        json(response, 200, session);
      } else {
        json(response, 401, { error: "invalid_credentials" });
      }
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/auth/v1/token" &&
      url.searchParams.get("grant_type") === "refresh_token"
    ) {
      const body = await requestBody(request);
      json(
        response,
        body.refresh_token === session.refresh_token ? 200 : 401,
        body.refresh_token === session.refresh_token
          ? session
          : { error: "invalid_refresh_token" },
      );
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/auth/v1/user" &&
      request.headers.authorization === `Bearer ${accessToken}`
    ) {
      json(response, 200, sessionUser);
      return;
    }
    json(response, 404, { error: "not_found" });
  });
  await new Promise((resolvePromise, reject) => {
    authServer.once("error", reject);
    authServer.listen(authPort, "127.0.0.1", resolvePromise);
  });
}

async function seedOperator() {
  const workspacePermissions = {
    overview: "READ",
    frontdesk: "READ",
    inventory: "NONE",
    website: "NONE",
    groups: "NONE",
    finance: "READ",
    accounting: "NONE",
    channels: "NONE",
    rooms: "READ",
    reports: "READ",
    master: "NONE",
    revenue: "NONE",
    users: "NONE",
    audit: "NONE",
  };
  await sql`
    DELETE FROM role_assignments
     WHERE property_id='prop-seoul' AND email=${email}
  `;
  await sql`
    INSERT INTO role_assignments(
      id,property_id,email,role,active,created_at,auth_user_id,display_name,
      workspace_permissions,can_export,must_change_password,updated_by
    ) VALUES (
      ${assignmentId},'prop-seoul',${email},'VIEWER',true,clock_timestamp(),
      ${authUserId},'검색 QA 관리자',${sql.json(workspacePermissions)},
      false,false,'search-ui-qa'
    )
  `;
}

async function waitForReady() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (appProcess?.exitCode != null) {
      throw new Error(
        `Next.js exited before readiness:\n${appLogs.slice(-30).join("")}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        cache: "no-store",
      });
      if (response.ok) {
        const body = await response.json();
        if (
          body.schemaVersion ===
          "202607230035_search_term_candidate_performance"
        )
          return;
      }
    } catch {
      // The process is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `Next.js did not become ready:\n${appLogs.slice(-30).join("")}`,
  );
}

async function startApplication() {
  const nextCli = resolve("node_modules", "next", "dist", "bin", "next");
  appProcess = spawn(process.execPath, [nextCli, "start", "-p", String(appPort)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: databaseUrl,
      SUPABASE_URL: authUrl,
      SUPABASE_SECRET_KEY: "search-e2e-service-key",
      AUTH_SECRET: authSecret,
      SEARCH_CURSOR_SECRET: authSecret,
      PMS_RATE_LIMIT_SECRET: authSecret,
      PMS_ALLOW_LOCAL_ADMIN: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  for (const stream of [appProcess.stdout, appProcess.stderr]) {
    stream.on("data", (chunk) => {
      appLogs.push(chunk.toString("utf8"));
      if (appLogs.length > 200) appLogs.shift();
    });
  }
  await waitForReady();
}

async function login(page) {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  const [loginResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url() === `${baseUrl}/api/auth/login` &&
        response.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Talos 로그인" }).click(),
  ]);
  if (!loginResponse.ok()) {
    throw new Error(
      `Login API failed (${loginResponse.status()}): ${await loginResponse.text()}`,
    );
  }
  await page.waitForURL(/\/overview$/u, { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("combobox", { name: "PMS 통합 검색" }),
  ).toBeVisible();
}

async function runScenario(viewport, mobile) {
  const context = await browser.newContext({ viewport, locale: "ko-KR" });
  await context.route("https://static.toss.im/**", (route) =>
    route.fulfill({ status: 204, contentType: "text/css", body: "" }),
  );
  const page = await context.newPage();
  const clientErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") clientErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (
      response.url().startsWith(baseUrl) &&
      response.status() >= 500
    )
      clientErrors.push(`${response.status()} ${response.url()}`);
  });

  try {
    await login(page);
    const sessionCookies = await context.cookies(baseUrl);
    const accessCookie = sessionCookies.find(
      (cookie) => cookie.name === "aurora-pms-access",
    );
    expect(accessCookie).toBeTruthy();
    expect(accessCookie?.httpOnly).toBe(true);
    expect(accessCookie?.secure).toBe(true);
    expect(accessCookie?.sameSite).toBe("Lax");
    const search = page.getByRole("combobox", { name: "PMS 통합 검색" });

    await search.fill("Kim Minji");
    const romanizedResult = page
      .getByRole("option")
      .filter({ hasText: "민지" });
    await expect(romanizedResult).toHaveCount(1);
    await expect(romanizedResult).toBeVisible();

    await search.fill("rlaalswl");
    await expect(
      page.getByText("한/영 키 입력을 자동 교정했어요."),
    ).toBeVisible();
    const correctedResult = page
      .getByRole("option")
      .filter({ hasText: "민지" });
    await expect(correctedResult).toHaveCount(1);
    await expect(correctedResult).toBeVisible();

    await search.fill("301");
    const exactRoomResult = page
      .getByRole("option")
      .filter({ hasText: "301호" });
    await expect(exactRoomResult).toHaveCount(1);
    await expect(exactRoomResult).toBeVisible();
    await search.press("Enter");
    await page.waitForURL(/\/rooms\?focus=room-301$/u);

    if (!mobile) {
      await page.goto(
        `${baseUrl}/reports?report=search_quality&from=2026-07-16&to=2026-07-23`,
      );
      await expect(page.getByRole("heading", { name: "리포트 센터" })).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "검색 품질 · 경보" }),
      ).toBeVisible();
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    expect(clientErrors).toEqual([]);

    await page.evaluate(async () => {
      await fetch("/api/auth/logout", { method: "POST" });
    });
    await page.goto(`${baseUrl}/overview`);
    await page.waitForURL(/\/login$/u);
  } finally {
    await context.close();
  }
}

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (browser) await browser.close().catch(() => {});
  if (appProcess && appProcess.exitCode == null) appProcess.kill("SIGTERM");
  if (authServer) {
    await new Promise((resolvePromise) =>
      authServer.close(() => resolvePromise()),
    ).catch(() => {});
  }
  await sql`
    DELETE FROM role_assignments
     WHERE id=${assignmentId} AND property_id='prop-seoul'
  `.catch(() => {});
  await sql.end({ timeout: 2 }).catch(() => {});
}

process.once("SIGINT", () => {
  void cleanup().finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
  void cleanup().finally(() => process.exit(143));
});

try {
  await seedOperator();
  await startAuthServer();
  await startApplication();
  if (process.argv.includes("--harness-only")) {
    process.stdout.write(
      `${JSON.stringify({ status: "ready", baseUrl, email })}\n`,
    );
    await new Promise(() => {});
  } else {
    browser = await chromium.launch({ headless: true });
    await runScenario({ width: 1440, height: 1000 }, false);
    await runScenario({ width: 390, height: 844 }, true);
    process.stdout.write(
      `${JSON.stringify({
        status: "passed",
        scenarios: ["desktop", "mobile"],
        checks: [
          "password-login",
          "httpOnly-session",
          "romanized-name",
          "keyboard-correction",
          "room-search",
          "keyboard-navigation",
          "quality-report",
          "logout",
          "horizontal-overflow",
        ],
      })}\n`,
    );
  }
} finally {
  if (!process.argv.includes("--harness-only")) await cleanup();
}
