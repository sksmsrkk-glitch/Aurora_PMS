/**
 * Starts the durable queue immediately after a successful request. The job is
 * already committed before this runs, so a failed kick never rolls back hotel
 * work; the independent scheduler will pick it up on its next sweep.
 */
import { after } from "next/server";

/** Accepts only the fixed internal path and never derives the destination from Host. */
export function validatedWorkerEndpoint(
  configuredUrl: string,
  nodeEnvironment = process.env.NODE_ENV,
) {
  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    return null;
  }
  const localDevelopment =
    nodeEnvironment !== "production" &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (
    (!localDevelopment && url.protocol !== "https:") ||
    url.pathname !== "/api/internal/worker" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null;
  return url;
}

export function scheduleDurableWorkerKick() {
  const secret = process.env.CRON_SECRET || "";
  const configuredUrl = process.env.AURORA_WORKER_URL || "";
  if (!secret || !configuredUrl) return;

  const url = validatedWorkerEndpoint(configuredUrl);
  if (!url) {
    console.error("Aurora worker kick is disabled: unsafe worker endpoint");
    return;
  }

  after(async () => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok)
        console.error(`Aurora worker kick returned HTTP ${response.status}`);
    } catch (error) {
      console.error(
        "Aurora worker kick failed; the scheduled sweep remains authoritative",
        error instanceof Error ? error.name : "WORKER_KICK_ERROR",
      );
    }
  });
}
