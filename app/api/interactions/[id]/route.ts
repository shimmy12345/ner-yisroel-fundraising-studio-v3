import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { extractInteraction, reminderDueAt, type InteractionKind, type ReminderChoice } from "../../../../lib/capture/interaction";
import { completedPlannedAt, isCompletedActivity, isNoResponseActivity, isScheduledActivity } from "../../../../lib/workspace/scheduled-activity";
import { logger } from "../../../../lib/logger";

type InteractionRow = { id: string; donor_id: string; type: string; occurred_at: number; summary: string; source: string; created_at: number };
type DonorContext = { relationship_summary: string | null; institutional_memory: string | null };
type EditBody = { donorId?: string; note?: string; type?: InteractionKind; subject?: string; reminder?: ReminderChoice; customDate?: string; occurredAt?: string; acceptRelationshipSnapshot?: boolean };
const kinds = new Set<InteractionKind>(["call", "email", "meeting", "visit", "note", "personal"]);
const reminders = new Set<ReminderChoice>(["none", "tomorrow", "next-week", "custom"]);

function extraction(row: Pick<InteractionRow, "type" | "summary">) {
  const [subject = "Interaction", ...noteParts] = row.summary.split("\n");
  const kind = kinds.has(row.type as InteractionKind) ? row.type as InteractionKind : "note";
  return extractInteraction(noteParts.join("\n") || subject, kind, subject);
}

async function ownedInteraction(id: string, userId: string) {
  return env.DB.prepare(`SELECT i.id, i.donor_id, i.type, i.occurred_at, i.summary, i.source, i.created_at
    FROM interactions i JOIN donors d ON d.id = i.donor_id
    WHERE i.id = ? AND i.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live' LIMIT 1`)
    .bind(id, userId, userId).first<InteractionRow>();
}

async function latestOther(donorId: string, userId: string, excludeId: string) {
  return env.DB.prepare(`SELECT id, donor_id, type, occurred_at, summary, source, created_at FROM interactions
    WHERE donor_id = ? AND user_id = ? AND id != ?
      AND source NOT LIKE 'archived:%' AND source NOT LIKE 'cancelled:%'
      AND (source LIKE 'capture-completed:%' OR (source NOT LIKE 'capture-scheduled:%' AND occurred_at <= created_at))
    ORDER BY occurred_at DESC LIMIT 1`).bind(donorId, userId, excludeId).first<InteractionRow>();
}

function contextStatement(donorId: string, userId: string, oldContext: ReturnType<typeof extraction>, replacement: ReturnType<typeof extraction> | null) {
  return env.DB.prepare(`UPDATE donors SET
    relationship_summary = CASE WHEN relationship_summary = ? THEN ? ELSE relationship_summary END,
    institutional_memory = CASE WHEN institutional_memory = ? THEN ? ELSE institutional_memory END,
    updated_at = ? WHERE id = ? AND owner_user_id = ? AND data_source = 'live'`)
    .bind(oldContext.relationshipSummary, replacement?.relationshipSummary ?? null, oldContext.memory, replacement?.memory ?? null, Math.floor(Date.now() / 1000), donorId, userId);
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const { id } = await params;
  const existing = await ownedInteraction(id, profile.id);
  if (!existing) return Response.json({ error: "Activity not found" }, { status: 404 });
  if (existing.source.startsWith("cancelled:") || existing.source.startsWith("archived:")) return Response.json({ error: "Cancelled or archived activities cannot be edited" }, { status: 409 });

  const body = await request.json().catch(() => null) as EditBody | null;
  const note = body?.note?.trim() ?? "";
  const donorId = body?.donorId ?? "";
  if (!body || !donorId || note.length < 4 || note.length > 5000 || !body.type || !kinds.has(body.type)) return Response.json({ error: "Choose a donor, activity type, and notes" }, { status: 422 });
  const donor = await env.DB.prepare("SELECT id FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live'").bind(donorId, profile.id).first<{ id: string }>();
  if (!donor) return Response.json({ error: "Donor not found" }, { status: 404 });
  const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date(existing.occurred_at * 1000);
  if (!Number.isFinite(occurredAt.getTime())) return Response.json({ error: "Choose a valid activity date and time" }, { status: 422 });
  const nowDate = new Date();
  const now = Math.floor(nowDate.getTime() / 1000);
  const wasCompleted = isCompletedActivity(existing.source);
  const scheduled = !wasCompleted && occurredAt.getTime() > nowDate.getTime();
  const reminder = reminders.has(body.reminder ?? "none") ? body.reminder ?? "none" : "none";
  const dueAt = reminderDueAt(reminder, body.customDate, nowDate);
  if (reminder === "custom" && !dueAt) return Response.json({ error: "Choose a custom reminder date" }, { status: 422 });
  const next = extractInteraction(note, body.type, body.subject);
  const old = extraction(existing);
  const occurredAtEpoch = Math.floor(occurredAt.getTime() / 1000);
  const plannedAt = completedPlannedAt(existing.source);
  const source = wasCompleted && plannedAt
    ? `capture-completed:${plannedAt}:${isNoResponseActivity(existing.source) ? "no-response" : "completed"}:capture:${next.type}`
    : `${scheduled ? "capture-scheduled" : "capture"}:${next.type}`;
  const reminderId = `activity-${id}`;
  const statements = [
    env.DB.prepare("UPDATE interactions SET donor_id = ?, type = ?, occurred_at = ?, summary = ?, source = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(donorId, next.type, occurredAtEpoch, `${next.subject}\n${next.summary}`, source, now, id, profile.id),
  ];
  if (dueAt) statements.push(env.DB.prepare(`INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 94, 'open', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET donor_id = excluded.donor_id, action = excluded.action, reason = excluded.reason, status = 'open', due_at = excluded.due_at, updated_at = excluded.updated_at`)
    .bind(reminderId, donorId, profile.id, next.nextAction, "Reminder requested for this activity.", Math.floor(dueAt.getTime() / 1000), now, now));
  else statements.push(env.DB.prepare("DELETE FROM recommendations WHERE id = ? AND user_id = ?").bind(reminderId, profile.id));

  const oldOther = await latestOther(existing.donor_id, profile.id, id);
  const newOther = donorId === existing.donor_id ? oldOther : await latestOther(donorId, profile.id, id);
  if (body.acceptRelationshipSnapshot === true && donorId !== existing.donor_id) statements.push(contextStatement(existing.donor_id, profile.id, old, oldOther ? extraction(oldOther) : null));
  if (body.acceptRelationshipSnapshot === true && !scheduled && (!newOther || occurredAtEpoch >= newOther.occurred_at)) {
    statements.push(env.DB.prepare("UPDATE donors SET relationship_summary = ?, institutional_memory = ?, relationship_health = 86, updated_at = ? WHERE id = ? AND owner_user_id = ? AND data_source = 'live'").bind(next.relationshipSummary, next.memory, now, donorId, profile.id));
  } else if (body.acceptRelationshipSnapshot === true && donorId === existing.donor_id) {
    statements.push(contextStatement(donorId, profile.id, old, newOther ? extraction(newOther) : null));
  }

  try { await env.DB.batch(statements); }
  catch (error) { logger.error("activity_edit_failed", error, { interactionId: id, userId: profile.id }); return Response.json({ error: "Activity could not be updated" }, { status: 500 }); }
  logger.info("activity_edited", { interactionId: id, userId: profile.id });
  return Response.json({ interactionId: id, occurredAt: occurredAt.toISOString(), scheduled, reminderAt: dueAt?.toISOString() ?? null, relationshipUpdated: body.acceptRelationshipSnapshot === true && !scheduled, extracted: next });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const { id } = await params;
  const existing = await ownedInteraction(id, profile.id);
  if (!existing) return Response.json({ error: "Activity not found" }, { status: 404 });
  if (existing.source.startsWith("cancelled:") || existing.source.startsWith("archived:")) return Response.json({ error: "Activity is already inactive" }, { status: 409 });
  const body = await request.json().catch(() => null) as { action?: "cancel" | "archive" } | null;
  const now = Math.floor(Date.now() / 1000);
  const scheduled = isScheduledActivity(existing.source, existing.occurred_at, existing.created_at);
  if (body?.action === "cancel" && (!scheduled || existing.occurred_at <= now)) return Response.json({ error: "Only future scheduled activities can be cancelled" }, { status: 409 });
  if (body?.action === "archive" && scheduled) return Response.json({ error: "Scheduled activities must be cancelled, not archived" }, { status: 409 });
  if (body?.action !== "cancel" && body?.action !== "archive") return Response.json({ error: "Choose cancel or archive" }, { status: 422 });
  const prefix = body.action === "cancel" ? "cancelled:" : "archived:";
  const statements = [
    env.DB.prepare("UPDATE interactions SET source = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(`${prefix}${existing.source}`, now, id, profile.id),
    env.DB.prepare("DELETE FROM recommendations WHERE id = ? AND user_id = ?").bind(`activity-${id}`, profile.id),
  ];
  if (body.action === "archive") {
    const replacement = await latestOther(existing.donor_id, profile.id, id);
    statements.push(contextStatement(existing.donor_id, profile.id, extraction(existing), replacement ? extraction(replacement) : null));
  }
  try { await env.DB.batch(statements); }
  catch (error) { logger.error("activity_state_failed", error, { interactionId: id, userId: profile.id, action: body.action }); return Response.json({ error: "Activity could not be updated" }, { status: 500 }); }
  logger.info("activity_state_changed", { interactionId: id, userId: profile.id, action: body.action });
  return Response.json({ interactionId: id, status: body.action === "cancel" ? "cancelled" : "archived" });
}
