/**
 * Intentionally returns no favicon image. Talos PMS uses a text-only identity,
 * so browsers receive a cacheable empty response instead of requesting a
 * deleted legacy BI/CI asset and producing a noisy 404.
 */
export function GET() {
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "public, max-age=86400" },
  });
}
