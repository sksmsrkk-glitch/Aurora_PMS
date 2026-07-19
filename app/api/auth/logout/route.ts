/** Session logout endpoint that revokes and clears PMS cookies. */
import { signOut } from "../../../supabase-session";
import { clearSelectedProperty } from "../../../property-selection";

export const runtime = "nodejs";

export async function POST() {
  await Promise.all([signOut(),clearSelectedProperty()]);
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
