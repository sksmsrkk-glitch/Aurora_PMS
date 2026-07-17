/** Pure proxy-trust policy shared by request controls and behavior tests. */

export function clientAddress(request: Request) {
  // Vercel overwrites x-forwarded-for and exposes x-vercel-forwarded-for as the
  // proxy-safe client address. Other proxies require explicit operator trust.
  if (process.env.VERCEL) {
    return (request.headers.get("x-vercel-forwarded-for") || request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  }
  if (process.env.PMS_TRUST_PROXY === "true") {
    return (request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown").split(",")[0].trim();
  }
  return "untrusted-direct-client";
}
