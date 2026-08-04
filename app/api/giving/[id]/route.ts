import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { logger } from "../../../../lib/logger";

type ActivityRow = { id: string; donor_id: string; external_source: string; workspace_status: string; private_note: string | null; updated_at: number };
const statusByAction = { hide: "hidden", duplicate: "duplicate", needs_review: "needs_review", invalid: "invalid", restore: "active" } as const;

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as { action?: unknown; donorId?: unknown; note?: unknown; expectedUpdatedAt?: unknown } | null;
  const action = typeof body?.action === "string" ? body.action : "";
  if (![...Object.keys(statusByAction), "move", "note"].includes(action)) return Response.json({ error: "Choose a supported record action." }, { status: 422 });
  const current = await env.DB.prepare("SELECT id,donor_id,external_source,workspace_status,private_note,updated_at FROM giving_activities WHERE id=? AND owner_user_id=? AND record_origin='live' LIMIT 1").bind(id, profile.id).first<ActivityRow>();
  if (!current) return Response.json({ error: "Giving record not found." }, { status: 404 });
  if (!Number.isInteger(body?.expectedUpdatedAt) || body?.expectedUpdatedAt !== current.updated_at) return Response.json({ error: "This record changed after the page loaded. Refresh before trying again." }, { status: 409 });
  const now = Math.max(Math.floor(Date.now() / 1000), current.updated_at + 1);
  const auditId = crypto.randomUUID();

  if (action === "move") {
    const donorId = typeof body?.donorId === "string" ? body.donorId.trim() : "";
    if (!donorId || donorId === current.donor_id) return Response.json({ error: "Choose a different donor." }, { status: 422 });
    const donor = await env.DB.prepare("SELECT id FROM donors WHERE id=? AND owner_user_id=? AND data_source='live' AND archived_at IS NULL LIMIT 1").bind(donorId, profile.id).first<{ id: string }>();
    if (!donor) return Response.json({ error: "The selected donor is unavailable." }, { status: 422 });
    const linkedPending = await env.DB.prepare("SELECT id,workspace_status,private_note FROM giving_activities WHERE owner_user_id=? AND donor_id=? AND category='pending_gift' AND confirmed_by_activity_id=?").bind(profile.id, current.donor_id, id).all<{ id: string; workspace_status: string; private_note: string | null }>();
    try {
      await env.DB.batch([
        env.DB.prepare("UPDATE giving_activities SET donor_id=?,updated_at=? WHERE id=? AND owner_user_id=? AND donor_id=? AND updated_at=?").bind(donor.id, now, id, profile.id, current.donor_id, current.updated_at),
        ...linkedPending.results.map((pending) => env.DB.prepare("UPDATE giving_activities SET donor_id=?,updated_at=? WHERE id=? AND owner_user_id=? AND donor_id=? AND confirmed_by_activity_id=?").bind(donor.id, now, pending.id, profile.id, current.donor_id, id)),
        env.DB.prepare("UPDATE jl_payment_assignment_audits SET donor_id=? WHERE pledge_activity_id=? AND user_id=? AND donor_id=?").bind(donor.id, id, profile.id, current.donor_id),
        env.DB.prepare(`INSERT INTO giving_activity_management_audits
          (id,user_id,activity_id,action,previous_donor_id,next_donor_id,previous_status,next_status,previous_note,next_note,created_at)
          VALUES (?,?,?,'donor_corrected',?,?,?,?,?,?,?)`).bind(auditId, profile.id, id, current.donor_id, donor.id, current.workspace_status, current.workspace_status, current.private_note, current.private_note, now),
        ...linkedPending.results.map((pending) => env.DB.prepare(`INSERT INTO giving_activity_management_audits
          (id,user_id,activity_id,action,previous_donor_id,next_donor_id,previous_status,next_status,previous_note,next_note,created_at)
          VALUES (?,?,?,'linked_pending_donor_corrected',?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), profile.id, pending.id, current.donor_id, donor.id, pending.workspace_status, pending.workspace_status, pending.private_note, pending.private_note, now)),
      ]);
      return Response.json({ auditId, status: current.workspace_status, donorId: donor.id, updatedAt: now, message: "Donor match corrected. Linked pledge-payment events moved with the record." });
    } catch (error) {
      logger.error("giving_donor_correction_failed", error, { userId: profile.id, activityId: id });
      return Response.json({ error: "The donor match could not be changed. No partial change was kept." }, { status: 500 });
    }
  }

  const nextStatus = action in statusByAction ? statusByAction[action as keyof typeof statusByAction] : current.workspace_status;
  const nextNote = action === "note" ? (typeof body?.note === "string" ? body.note.trim().slice(0, 2000) || null : null) : current.private_note;
  if (nextStatus === current.workspace_status && nextNote === current.private_note) return Response.json({ auditId: null, status: current.workspace_status, donorId: current.donor_id, updatedAt: current.updated_at, message: "No changes were needed." });
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE giving_activities SET workspace_status=?,private_note=?,updated_at=? WHERE id=? AND owner_user_id=? AND updated_at=?").bind(nextStatus, nextNote, now, id, profile.id, current.updated_at),
      env.DB.prepare(`INSERT INTO giving_activity_management_audits
        (id,user_id,activity_id,action,previous_donor_id,next_donor_id,previous_status,next_status,previous_note,next_note,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(auditId, profile.id, id, action === "note" ? "private_note_changed" : action, current.donor_id, current.donor_id, current.workspace_status, nextStatus, current.private_note, nextNote, now),
    ]);
    return Response.json({ auditId, status: nextStatus, donorId: current.donor_id, updatedAt: now, message: action === "restore" ? "Giving record restored to workspace totals." : action === "note" ? "Private note saved." : "Giving record updated. You can restore it at any time." });
  } catch (error) {
    logger.error("giving_management_failed", error, { userId: profile.id, activityId: id, action });
    return Response.json({ error: "The giving record could not be updated. No partial change was kept." }, { status: 500 });
  }
}
