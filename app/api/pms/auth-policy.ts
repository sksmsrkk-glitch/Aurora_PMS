/** Pure environment and token policy for explicitly enabled local demo access. */
import { timingSafeEqual } from "node:crypto";

export function demoAuthenticationEnabled(request: Request) {
  // Host-derived values are never authentication evidence because reverse proxies
  // can rewrite them. Production always fails closed regardless of local flags.
  if (process.env.NODE_ENV === "production" || process.env.PMS_ALLOW_DEMO_AUTH !== "true") return false;
  const expected = process.env.PMS_DEMO_AUTH_TOKEN || "";
  const supplied = request.headers.get("x-aurora-demo-token") || "";
  if (expected.length < 32 || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
