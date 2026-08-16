import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";

// Must match every queueId shape live-data.ts actually generates: reminders
// and scheduled activities keep their own prefixes, and every recommendation-
// engine-sourced suggestion (acknowledge_gift, follow_up_pledge,
// continue_conversation, relationship_opportunity, solicit,
// reconnect_contact_gap) shares a single "recommendation" prefix -- see
// `queueId: \`recommendation:${donorId}:${recommendation.kind}\`` in
// lib/workspace/live-data.ts. The old gift/commitment/contact-gap prefixes
// were replaced by that unification and are no longer generated anywhere.
const validKey = /^(reminder|activity|recommendation):[^:]{1,180}:[^:]{1,80}$/;

export async function POST(request: Request) {
  return updateDismissal(request, "dismiss");
}

export async function DELETE(request: Request) {
  return updateDismissal(request, "restore");
}

async function updateDismissal(request: Request, action: "dismiss" | "restore") {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const body = await request.json().catch(() => ({})) as { queueId?: string; donorId?: string };
  const queueId = body.queueId?.trim() ?? "";
  const donorId = body.donorId?.trim() ?? "";
  if (!validKey.test(queueId) || !donorId) return Response.json({ error: "A valid queue suggestion is required" }, { status: 400 });
  const donor = await env.DB.prepare("SELECT id FROM donors WHERE id=? AND owner_user_id=? AND data_source='live' AND archived_at IS NULL").bind(donorId, profile.id).first<{ id: string }>();
  if (!donor) return Response.json({ error: "Live donor not found" }, { status: 404 });
  if (action === "restore") {
    await env.DB.prepare("DELETE FROM relationship_queue_dismissals WHERE user_id=? AND item_key=? AND donor_id=?").bind(profile.id, queueId, donorId).run();
    return Response.json({ restored: true });
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO relationship_queue_dismissals (user_id,item_key,donor_id,dismissed_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id,item_key) DO UPDATE SET donor_id=excluded.donor_id,dismissed_at=excluded.dismissed_at`).bind(profile.id, queueId, donorId, now).run();
  return Response.json({ dismissed: true });
}
