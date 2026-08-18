import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { logger } from "../../../../../lib/logger";
import type { InteractionKind } from "../../../../../lib/capture/interaction";

type SharedActivityRow = { id: string; type: string; occurred_at: number; summary: string; source: string; deleted_at: number | null };
type LinkedInteractionRow = { id: string; donor_id: string; source: string };
type PatchBody = { summary?: string; type?: InteractionKind; occurredAt?: string };
type DeleteBody = { action?: "remove-recipient" | "delete-activity"; donorId?: string };

const KINDS = new Set<InteractionKind>(["call", "email", "meeting", "visit", "note", "personal"]);

async function ownedSharedActivity(id: string, userId: string) {
  return env.DB.prepare("SELECT id, type, occurred_at, summary, source, deleted_at FROM shared_activities WHERE id = ? AND user_id = ? LIMIT 1").bind(id, userId).first<SharedActivityRow>();
}

// Edits the single canonical copy (summary always; type/occurred_at only
// when provided). type/occurred_at are also denormalized onto every linked
// interactions row (Last Contact, the timeline, and recommendation scoring
// all read them from that row, not from shared_activities), so those two
// fields propagate to every still-linked row in the same batch. summary
// never propagates -- every read path already prefers
// shared_activities.summary over the per-row copy when linked, so a fan-out
// write there would just be redundant, not necessary for correctness.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const { id } = await params;
  const existing = await ownedSharedActivity(id, profile.id);
  if (!existing || existing.deleted_at !== null) return Response.json({ error: "Shared activity not found" }, { status: 404 });

  const body = await request.json().catch(() => null) as PatchBody | null;
  const summary = body?.summary?.trim() ?? "";
  if (!body || summary.length < 4 || summary.length > 5000) return Response.json({ error: "A summary is required" }, { status: 422 });
  if (body.type && !KINDS.has(body.type)) return Response.json({ error: "Invalid interaction type" }, { status: 422 });
  const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date(existing.occurred_at * 1000);
  if (!Number.isFinite(occurredAt.getTime())) return Response.json({ error: "Choose a valid activity date" }, { status: 422 });

  const now = Math.floor(Date.now() / 1000);
  const type = body.type ?? existing.type;
  const occurredAtEpoch = Math.floor(occurredAt.getTime() / 1000);
  const statements = [
    env.DB.prepare("UPDATE shared_activities SET summary = ?, type = ?, occurred_at = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(summary, type, occurredAtEpoch, now, id, profile.id),
    // Only still-linked, still-active rows -- a recipient already removed
    // (shared_activity_id cleared) or a cancelled row must not be touched.
    env.DB.prepare("UPDATE interactions SET type = ?, occurred_at = ?, updated_at = ? WHERE shared_activity_id = ? AND user_id = ? AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%'")
      .bind(type, occurredAtEpoch, now, id, profile.id),
  ];
  try { await env.DB.batch(statements); }
  catch (error) { logger.error("shared_activity_edit_failed", error, { sharedActivityId: id, userId: profile.id }); return Response.json({ error: "Shared activity could not be updated" }, { status: 500 }); }
  logger.info("shared_activity_edited", { sharedActivityId: id, userId: profile.id });
  return Response.json({ sharedActivityId: id, occurredAt: occurredAt.toISOString() });
}

// Two distinct, deliberately non-confusable actions in one route:
// remove-recipient detaches exactly one donor's link (soft-cancelled, same
// convention as a single-donor delete) and leaves everyone else and the
// activity itself untouched; delete-activity soft-cancels every still-
// linked row and marks the parent deleted. Neither is a real SQL DELETE.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const { id } = await params;
  const existing = await ownedSharedActivity(id, profile.id);
  if (!existing || existing.deleted_at !== null) return Response.json({ error: "Shared activity not found" }, { status: 404 });

  const body = await request.json().catch(() => null) as DeleteBody | null;
  const now = Math.floor(Date.now() / 1000);

  if (body?.action === "remove-recipient") {
    const donorId = body.donorId ?? "";
    if (!donorId) return Response.json({ error: "donorId is required" }, { status: 422 });
    const link = await env.DB.prepare("SELECT id, donor_id, source FROM interactions WHERE shared_activity_id = ? AND donor_id = ? AND user_id = ? AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%' LIMIT 1")
      .bind(id, donorId, profile.id).first<LinkedInteractionRow>();
    if (!link) return Response.json({ error: "That donor is not linked to this activity" }, { status: 404 });
    const statements = [
      env.DB.prepare("UPDATE interactions SET source = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(`cancelled:${link.source}`, now, link.id, profile.id),
      env.DB.prepare("UPDATE shared_activities SET recipient_count = MAX(0, recipient_count - 1), updated_at = ? WHERE id = ? AND user_id = ?").bind(now, id, profile.id),
      env.DB.prepare("INSERT INTO shared_activity_recipient_audits (id, shared_activity_id, donor_id, user_id, action, created_at) VALUES (?,?,?,?,'removed',?)").bind(crypto.randomUUID(), id, donorId, profile.id, now),
    ];
    try { await env.DB.batch(statements); }
    catch (error) { logger.error("shared_activity_remove_recipient_failed", error, { sharedActivityId: id, donorId, userId: profile.id }); return Response.json({ error: "Recipient could not be removed" }, { status: 500 }); }
    logger.info("shared_activity_recipient_removed", { sharedActivityId: id, donorId, userId: profile.id });
    return Response.json({ sharedActivityId: id, donorId, status: "removed" });
  }

  if (body?.action === "delete-activity") {
    const links = await env.DB.prepare("SELECT id, donor_id, source FROM interactions WHERE shared_activity_id = ? AND user_id = ? AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%'").bind(id, profile.id).all<LinkedInteractionRow>();
    const statements = [
      ...links.results.map((link) => env.DB.prepare("UPDATE interactions SET source = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(`cancelled:${link.source}`, now, link.id, profile.id)),
      env.DB.prepare("UPDATE shared_activities SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(now, now, id, profile.id),
    ];
    try { await env.DB.batch(statements); }
    catch (error) { logger.error("shared_activity_delete_failed", error, { sharedActivityId: id, userId: profile.id }); return Response.json({ error: "Shared activity could not be deleted" }, { status: 500 }); }
    logger.info("shared_activity_deleted", { sharedActivityId: id, userId: profile.id, donorCount: links.results.length });
    return Response.json({ sharedActivityId: id, status: "deleted", donorCount: links.results.length });
  }

  return Response.json({ error: "Choose remove-recipient or delete-activity" }, { status: 422 });
}
