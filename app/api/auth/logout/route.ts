import { signOut } from "../../../supabase-session";

export const runtime = "nodejs";

export async function POST() {
  await signOut();
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
