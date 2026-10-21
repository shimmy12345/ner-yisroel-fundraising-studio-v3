import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { extractInteraction, reminderDueAt, type InteractionKind, type ReminderChoice } from "../../../../lib/capture/interaction";
import { applyInteractionEdit } from "../../../../lib/capture/interaction-edit";
import { completedPlannedAt, isCompletedActivity, isNoResponseActivity, isScheduledActivity } from "../../../../lib/workspace/scheduled-activity";
import { logger } from "../../../../lib/logger";
import { planFactArchival } from "../../../../lib/relationships/fact-accept";

type InteractionRow = { id: string; donor_id: string; type: string; occurred_at: number; summary: string; source: string; created_at: number };
type EditBody = { donorId?: string; note?: string; type?: InteractionKind; subject?: string; reminder?: ReminderChoice; customDate?: string; occurredAt?: string; acceptRelationshipSnapshot?: boolean; expectedSummary?: string };
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
  // Concurrency safety (2026-10-21, third follow-up review -- "a stale
  // editor must not silently overwrite ... an appended completion
  // note"): `expectedSummary`, when sent, is the exact row value this
  // edit form actually started from (see CaptureExperience's own
  // InitialActivity type). This early comparison is a fast-path
  // rejection for a client that is ALREADY known to be stale at request
  // time; it is deliberately not the only guard -- see
  // applyInteractionEdit's own doc comment for why the actual write
  // below is itself a compare-and-swap against this same baseline,
  // closing the gap this early check alone cannot (something else
  // landing between this check and that write, within this same
  // request).
  if (typeof body.expectedSummary === "string" && body.expectedSummary !== existing.summary) {
    return Response.json({
      error: "This activity was updated elsewhere since you opened this page. Your unsaved text has not been discarded -- copy it if you want to keep it, then reload to see the latest before saving again.",
      conflict: true,
    }, { status: 409 });
  }
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
  const summary = `${next.subject}\n${next.summary}`;
  // Concurrency safety (2026-10-21, third follow-up review): the
  // compare-and-swap baseline is the client's own `expectedSummary` when
  // provided, never just this request's own fresh read -- see
  // applyInteractionEdit's own doc comment.
  const casBaseline = typeof body.expectedSummary === "string" ? body.expectedSummary : existing.summary;

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
  //    silently reapply or overwrite." BOTH of these, and the reminder
  //    update, are now entirely conditional on applyInteractionEdit's
  //    own compare-and-swap having actually applied -- a rejected edit
  //    (stale `casBaseline`) never reaches either one.
  let outcome;
  try {
    outcome = await applyInteractionEdit(env.DB, {
      interactionId: id, userId: profile.id, existingDonorId: existing.donor_id, donorId, type: next.type,
      summary, casBaseline, source, occurredAtEpoch, now, reminderId,
      reminderDueAtEpoch: dueAt ? Math.floor(dueAt.getTime() / 1000) : null, reminderNextAction: next.nextAction,
      acceptRelationshipSnapshot: body.acceptRelationshipSnapshot === true, scheduled, note, subject: body.subject ?? "",
    });
  } catch (error) {
    logger.error("activity_edit_failed", error, { interactionId: id, userId: profile.id });
    return Response.json({ error: "Activity could not be updated" }, { status: 500 });
  }
  if (outcome.status === "conflict") {
    logger.info("activity_edit_stale", { interactionId: id, userId: profile.id });
    return Response.json({
      error: "This activity was updated elsewhere since you opened this page. Your unsaved text has not been discarded -- copy it if you want to keep it, then reload to see the latest before saving again.",
      conflict: true,
    }, { status: 409 });
  }
  logger.info("activity_edited", { interactionId: id, userId: profile.id });
  return Response.json({ interactionId: id, occurredAt: occurredAt.toISOString(), scheduled, reminderAt: dueAt?.toISOString() ?? null, relationshipUpdated: outcome.relationshipUpdated, extracted: next });
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
