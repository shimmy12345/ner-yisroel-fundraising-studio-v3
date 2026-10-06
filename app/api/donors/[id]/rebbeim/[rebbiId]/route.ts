import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../../lib/auth/profile";
import { logger } from "../../../../../../lib/logger";

// Removes only this one donor <-> Rebbi relationship. The canonical
// `rebbeim` row is never touched -- it remains available for every other
// donor and for future re-adding (see docs/AI-HANDOFF.md's "Donor
// Rebbeim" entry).
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; rebbiId: string }> }) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const { id: donorId, rebbiId } = await params;

  const donor = await env.DB.prepare("SELECT id FROM donors WHERE id=? AND owner_user_id=? AND data_source='live' LIMIT 1").bind(donorId, profile.id).first<{ id: string }>();
  if (!donor) return Response.json({ error: "Donor not found." }, { status: 404 });

  try {
    await env.DB.prepare("DELETE FROM donor_rebbeim WHERE donor_id=? AND rebbi_id=? AND user_id=?").bind(donorId, rebbiId, profile.id).run();
    logger.info("donor_rebbi_removed", { donorId, rebbiId, userId: profile.id });
    return Response.json({ ok: true });
  } catch (error) {
    logger.error("donor_rebbi_remove_failed", error, { donorId, rebbiId, userId: profile.id });
    return Response.json({ error: "The relationship could not be removed." }, { status: 500 });
  }
}
