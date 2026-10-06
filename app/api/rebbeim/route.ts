import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";

// Read-only listing of the canonical Rebbeim directory -- used by the
// donor-page "Add Rebbi" search and the Rebbeim directory page's own
// client-side filtering. No create/edit here in V1 (see
// docs/AI-HANDOFF.md's "Donor Rebbeim" entry for why manual add is
// restricted to this seeded directory).
export async function GET() {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);

  const result = await env.DB.prepare("SELECT id, display_name, normalized_name FROM rebbeim WHERE user_id = ? ORDER BY display_name").bind(profile.id).all<{ id: string; display_name: string; normalized_name: string }>();
  return Response.json({ rebbeim: result.results });
}
