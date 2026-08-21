import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { extractInteraction, reminderDueAt, type InteractionKind, type ReminderChoice } from "../../../../lib/capture/interaction";
import { completedPlannedAt, isCompletedActivity, isNoResponseActivity, isScheduledActivity } from "../../../../lib/workspace/scheduled-activity";
import { logger } from "../../../../lib/logger";
import { planFactAcceptance, planFactArchival } from "../../../../lib/relationships/fact-accept";

type InteractionRow = { id: string; donor_id: string; type: string; occurred_at: number; summary: string; source: string; created_at: number };
type EditBody = { donorId?: string; note?: string; type?: InteractionKind; subject?: string; reminder?: ReminderChoice; customDate?: string; occurredAt?: string; acceptRelationshipSnapshot?: boolean };
const kinds = new Set<InteractionKind>(["call", "email", "meeting", "visit", "note", "personal", "text"]);
const reminders = new Set<ReminderChoice>(["none", "tomorrow", "next-week", "custom"]);

async function ownedInteraction(id: string, userId: string) {
  return env.DB.prepare(`SELECT i.id, i.donor_id, i.type, i.occurred_at, i.summary, i.source, i.created_at
    FROM interactions i JOIN donors d ON d.id = i.donor_id
    WHERE i.id = ? AND i.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live' LIMIT 1`)
    .bind(id, userId, userId).first<InteractionRow>();
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
  const dueAt = reminderDueAt(reminder, body.customDate, nowDate, profile.timezone);
  if (reminder === "custom" && !dueAt) return Response.json({ error: "Choose a custom reminder date" }, { status: 422 });
  const next = extractInteraction(note, body.type, body.subject);
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

  // Relationship Intelligence Phase 2 (see docs/AI-HANDOFF.md's
  // "Relationship Intelligence Phase 2" section). Two independent
  // concerns, replacing the old contextStatement()/latestOther()-based
  // logic entirely:
  //
  // 1. Donor reassignment (donorId !== existing.donor_id): this
  //    interaction is leaving its old donor's history. Any CURRENT fact
  //    it sourced for that donor is archived (archived_with_source) --
  //    provenance integrity, never deletion -- independent of whether a
  //    new acceptance is also happening for the new donor below. This is
  //    an extension of the design's own already-approved archive
  //    semantics to a structurally analogous trigger (a source
  //    interaction no longer belonging to the donor), not a new
  //    invented behavior; flagged explicitly in docs/AI-HANDOFF.md as a
  //    case the original worked examples did not literally cover.
  // 2. Re-acceptance (acceptRelationshipSnapshot === true, and not
  //    scheduled): a genuine new accept event for the interaction's
  //    (possibly new) donor, attributed to this interaction's own id.
  //    planFactAcceptance()'s own same-source-interaction-first
  //    supersession rule means this correctly targets THIS interaction's
  //    own prior contribution (an edit correction) without needing the
  //    old "is this chronologically the latest interaction" branching at
  //    all -- that whole distinction is now irrelevant. Not accepting
  //    (the common edit case -- just fixing a typo) writes nothing here
  //    at all, exactly matching "editing without accepting must not
  //    silently reapply or overwrite."
  if (donorId !== existing.donor_id) {
    const archival = await planFactArchival({ donorId: existing.donor_id, userId: profile.id, sourceInteractionId: id, now });
    statements.push(...archival.statements);
  }
  let relationshipStatementIndex = -1;
  if (body.acceptRelationshipSnapshot === true && !scheduled) {
    const plan = await planFactAcceptance({
      donorId, userId: profile.id, sourceInteractionId: id, sourceInteractionOccurredAt: occurredAtEpoch,
      noteText: note, kind: next.type, subject: body.subject ?? "", now,
    });
    if (plan.relationshipStatementIndex >= 0) relationshipStatementIndex = statements.length + plan.relationshipStatementIndex;
    statements.push(...plan.statements);
  }

  let relationshipUpdated = false;
  try {
    const results = await env.DB.batch(statements) as unknown as Array<{ meta?: { changes?: number } }>;
    if (relationshipStatementIndex >= 0) relationshipUpdated = (results[relationshipStatementIndex]?.meta?.changes ?? 0) > 0;
  }
  catch (error) { logger.error("activity_edit_failed", error, { interactionId: id, userId: profile.id }); return Response.json({ error: "Activity could not be updated" }, { status: 500 }); }
  logger.info("activity_edited", { interactionId: id, userId: profile.id });
  return Response.json({ interactionId: id, occurredAt: occurredAt.toISOString(), scheduled, reminderAt: dueAt?.toISOString() ?? null, relationshipUpdated, extracted: next });
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
  // Relationship Intelligence Phase 2: archiving the source interaction
  // transitions any CURRENT fact it sourced to archived_with_source and
  // resynthesizes from whatever current facts remain -- NEVER promoting
  // some other, never-explicitly-accepted interaction's extraction to
  // fill the gap, per the approved design. This structurally closes the
  // pre-existing gap the old contextStatement()/latestOther() pairing
  // had (which pulled in another interaction's raw, unaccepted
  // extraction as the "replacement").
  if (body.action === "archive") {
    const archival = await planFactArchival({ donorId: existing.donor_id, userId: profile.id, sourceInteractionId: id, now });
    statements.push(...archival.statements);
  }
  try { await env.DB.batch(statements); }
  catch (error) { logger.error("activity_state_failed", error, { interactionId: id, userId: profile.id, action: body.action }); return Response.json({ error: "Activity could not be updated" }, { status: 500 }); }
  logger.info("activity_state_changed", { interactionId: id, userId: profile.id, action: body.action });
  return Response.json({ interactionId: id, status: body.action === "cancel" ? "cancelled" : "archived" });
}
