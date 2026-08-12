import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { isGiftAcknowledgmentStatus, isGiftSource } from "../../../../lib/giving/acknowledgment";
import { logger } from "../../../../lib/logger";

// Lightweight, append-only acknowledgment tracking ("Mark thank-you
// sent"). Deliberately never touches interactions, recommendations, or
// donors.relationship_summary/institutional_memory -- this only ever
// writes to gift_acknowledgments, and only ever as a new row, never an
// UPDATE, so a later status change never erases the record of what was
// marked before.

type Body = { giftSource?: unknown; giftId?: unknown; status?: unknown };

export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const body = await request.json().catch(() => null) as Body | null;
  const giftSource = body?.giftSource;
  const giftId = typeof body?.giftId === "string" ? body.giftId.trim() : "";
  const status = body?.status;
  if (!isGiftSource(giftSource)) return Response.json({ error: "Choose a supported gift source." }, { status: 422 });
  if (!giftId) return Response.json({ error: "A gift is required." }, { status: 422 });
  if (!isGiftAcknowledgmentStatus(status)) return Response.json({ error: "Choose a supported acknowledgment status." }, { status: 422 });

  // Ownership check: the referenced gift/giving activity must belong to
  // this owner's live records -- the same way every other write-capable
  // route in this app scopes its target row before writing anything.
  const donor = giftSource === "giving_activity"
    ? await env.DB.prepare("SELECT donor_id FROM giving_activities WHERE id=? AND owner_user_id=? AND record_origin='live' LIMIT 1").bind(giftId, profile.id).first<{ donor_id: string }>()
    : await env.DB.prepare("SELECT g.donor_id FROM gifts g JOIN donors d ON d.id=g.donor_id WHERE g.id=? AND d.owner_user_id=? AND d.data_source='live' LIMIT 1").bind(giftId, profile.id).first<{ donor_id: string }>();
  if (!donor) return Response.json({ error: "Gift not found." }, { status: 404 });

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(`INSERT INTO gift_acknowledgments (id, donor_id, user_id, gift_source, gift_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(id, donor.donor_id, profile.id, giftSource, giftId, status, now, now).run();
    logger.info("gift_acknowledgment_recorded", { userId: profile.id, donorId: donor.donor_id, giftSource, giftId, status });
    return Response.json({ id, status, createdAt: now }, { status: 201 });
  } catch (error) {
    logger.error("gift_acknowledgment_failed", error, { userId: profile.id, giftSource, giftId });
    return Response.json({ error: "The acknowledgment could not be saved." }, { status: 500 });
  }
}
