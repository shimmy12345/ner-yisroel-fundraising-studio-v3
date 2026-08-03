import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const { id } = await params;
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(`UPDATE recommendations
    SET status = 'completed', updated_at = ?
    WHERE id = ? AND user_id = ? AND status = 'open'
      AND donor_id IN (SELECT id FROM donors WHERE owner_user_id = ? AND data_source = 'live')`)
    .bind(now, id, profile.id, profile.id).run() as { meta: { changes?: number } };
  if ((result.meta.changes ?? 0) !== 1) return Response.json({ error: "Open reminder not found" }, { status: 404 });
  return Response.json({ completed: true });
}
