import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";

// Mirrors ../complete/route.ts exactly, except the target status --
// "dismissed" already has full support elsewhere (db/schema.ts's status
// enum, and lib/relationships/unified-timeline.ts's read-path filter,
// which already excludes it) but nothing previously wrote it via a
// user-facing action. Local D1 state only: no Monday.com API call, no
// write-back to the original import source, and (same as complete) the
// WHERE clause's status='open' guard means an already-completed or
// already-dismissed row can never be re-mutated by this route.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const { id } = await params;
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(`UPDATE recommendations
    SET status = 'dismissed', updated_at = ?
    WHERE id = ? AND user_id = ? AND status = 'open'
      AND donor_id IN (SELECT id FROM donors WHERE owner_user_id = ? AND data_source = 'live')`)
    .bind(now, id, profile.id, profile.id).run() as { meta: { changes?: number } };
  if ((result.meta.changes ?? 0) !== 1) return Response.json({ error: "Open reminder not found" }, { status: 404 });
  return Response.json({ dismissed: true });
}
