import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { logger } from "../../../../../lib/logger";

// Manual "add Rebbi to this donor" -- restricted to the existing
// canonical directory in V1 (see docs/AI-HANDOFF.md's "Donor Rebbeim"
// entry): the body carries an existing rebbiId, never arbitrary text, so
// a typo can never silently create a new canonical Rebbi. Idempotent:
// adding a Rebbi already connected to this donor is a safe no-op, not an
// error, since the review UI's own optimistic state could otherwise race
// a second click.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const { id: donorId } = await params;

  const donor = await env.DB.prepare("SELECT id FROM donors WHERE id=? AND owner_user_id=? AND data_source='live' AND archived_at IS NULL LIMIT 1").bind(donorId, profile.id).first<{ id: string }>();
  if (!donor) return Response.json({ error: "Donor not found." }, { status: 404 });

  const body = await request.json().catch(() => null) as { rebbiId?: string } | null;
  const rebbiId = body?.rebbiId?.trim();
  if (!rebbiId) return Response.json({ error: "A Rebbi must be selected." }, { status: 400 });

  const rebbi = await env.DB.prepare("SELECT id, display_name FROM rebbeim WHERE id=? AND user_id=? LIMIT 1").bind(rebbiId, profile.id).first<{ id: string; display_name: string }>();
  if (!rebbi) return Response.json({ error: "That Rebbi could not be found in the directory." }, { status: 404 });

  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(`INSERT INTO donor_rebbeim (donor_id, rebbi_id, user_id, source, created_at)
      SELECT ?, ?, ?, 'manual', ?
      WHERE NOT EXISTS (SELECT 1 FROM donor_rebbeim WHERE donor_id = ? AND rebbi_id = ?)`)
      .bind(donorId, rebbiId, profile.id, now, donorId, rebbiId).run();
    logger.info("donor_rebbi_added", { donorId, rebbiId, userId: profile.id });
    return Response.json({ rebbiId, displayName: rebbi.display_name }, { status: 201 });
  } catch (error) {
    logger.error("donor_rebbi_add_failed", error, { donorId, rebbiId, userId: profile.id });
    return Response.json({ error: "The Rebbi could not be added." }, { status: 500 });
  }
}
