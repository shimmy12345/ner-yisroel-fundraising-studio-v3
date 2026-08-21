import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { type InteractionKind } from "../../../../../lib/capture/interaction";
import { activityStatus, completedPlannedAt, originalActivitySource, reopenActivitySource } from "../../../../../lib/workspace/scheduled-activity";
import { logger } from "../../../../../lib/logger";
import { planFactAcceptance, planFactArchival } from "../../../../../lib/relationships/fact-accept";

type InteractionRow = {
  id: string; donor_id: string; type: string; occurred_at: number; summary: string; source: string; created_at: number;
};
type AuditRow = { id: string; previous_source: string; previous_occurred_at: number; previous_summary: string; follow_up_id: string | null };
type OutcomeAction = "complete" | "cancel" | "reschedule" | "no-response" | "reopen" | "undo";
type OutcomeBody = {
  action?: OutcomeAction; outcome?: string; notes?: string; completedAt?: string; rescheduledAt?: string;
  followUpEnabled?: boolean; followUpType?: string; followUpSubject?: string; followUpNotes?: string; followUpAt?: string; auditId?: string;
  // Option A (2026-08-21): explicit, per-request acceptance of the
  // proposed Relationship Snapshot -- same name, same semantics, and
  // (below) the same double-gate as the main capture route's
  // `acceptRelationshipSnapshot === true` check. Never inferred from
  // note content; must be sent `true` by the client, which itself only
  // ever sends `true` when its own local preview is non-null (mirrors
  // CaptureExperience.tsx's own gating, see that file for the identical
  // pattern this route intentionally reuses).
  acceptRelationshipSnapshot?: boolean;
};

const kinds = new Set<InteractionKind>(["call", "email", "meeting", "visit", "note", "personal", "text"]);
const parseDate = (value?: string) => { if (!value) return null; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed : null; };
const splitSummary = (summary: string) => {
  const [subject = "Interaction", ...parts] = summary.split("\n");
  const lines = parts.filter((line) => !line.startsWith("Outcome: "));
  const outcome = parts.find((line) => line.startsWith("Outcome: "))?.slice(9) ?? "";
  return { subject, notes: lines.join("\n") || subject, outcome };
};

async function ownedActivity(id: string, userId: string) {
  return env.DB.prepare(`SELECT i.id, i.donor_id, i.type, i.occurred_at, i.summary, i.source, i.created_at
    FROM interactions i JOIN donors d ON d.id = i.donor_id
    WHERE i.id = ? AND i.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live' LIMIT 1`)
    .bind(id, userId, userId).first<InteractionRow>();
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const { id } = await params;
  const existing = await ownedActivity(id, profile.id);
  if (!existing) return Response.json({ error: "Activity not found" }, { status: 404 });
  const body = await request.json().catch(() => null) as OutcomeBody | null;
  const allowed: OutcomeAction[] = ["complete", "cancel", "reschedule", "no-response", "reopen", "undo"];
  if (!body?.action || !allowed.includes(body.action)) return Response.json({ error: "Choose an activity outcome" }, { status: 422 });

  const nowDate = new Date();
  const now = Math.floor(nowDate.getTime() / 1000);
  const currentStatus = activityStatus(existing.source, existing.occurred_at, existing.created_at);

  if (body.action === "undo") {
    if (!body.auditId) return Response.json({ error: "The change to undo was not identified" }, { status: 422 });
    const audit = await env.DB.prepare(`SELECT id, previous_source, previous_occurred_at, previous_summary, follow_up_id
      FROM activity_status_audits WHERE id = ? AND interaction_id = ? AND user_id = ? AND undone_at IS NULL
      AND id = (SELECT id FROM activity_status_audits WHERE interaction_id = ? AND user_id = ? AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1)`)
      .bind(body.auditId, id, profile.id, id, profile.id).first<AuditRow>();
    if (!audit) return Response.json({ error: "This change can no longer be undone" }, { status: 409 });
    const statements = [
      env.DB.prepare("UPDATE interactions SET source = ?, occurred_at = ?, summary = ?, updated_at = ? WHERE id = ? AND user_id = ?")
        .bind(audit.previous_source, audit.previous_occurred_at, audit.previous_summary, now, id, profile.id),
      env.DB.prepare("UPDATE activity_status_audits SET undone_at = ? WHERE id = ? AND user_id = ? AND undone_at IS NULL").bind(now, audit.id, profile.id),
    ];
    if (audit.follow_up_id) statements.push(env.DB.prepare("UPDATE interactions SET source = CASE WHEN source LIKE 'cancelled:%' THEN source ELSE 'cancelled:' || source END, updated_at = ? WHERE id = ? AND user_id = ?").bind(now, audit.follow_up_id, profile.id));
    try { await env.DB.batch(statements); }
    catch (error) { logger.error("activity_outcome_undo_failed", error, { interactionId: id, userId: profile.id }); return Response.json({ error: "The change could not be undone" }, { status: 500 }); }
    return Response.json({ interactionId: id, status: activityStatus(audit.previous_source, audit.previous_occurred_at, existing.created_at), message: "The previous activity state was restored.", databaseChanges: true });
  }

  if (currentStatus === "archived" || currentStatus === "logged") return Response.json({ error: "This activity cannot use outcome controls" }, { status: 409 });
  const { subject, notes: existingNotes } = splitSummary(existing.summary);
  const notes = body.notes?.trim() || existingNotes;
  const plannedEpoch = completedPlannedAt(existing.source) ?? existing.occurred_at;
  let nextSource = existing.source;
  let nextOccurredAt = existing.occurred_at;
  let nextSummary = existing.summary;
  let nextStatus = currentStatus;

  if (body.action === "reopen") {
    if (!['completed', 'no-response', 'cancelled'].includes(currentStatus)) return Response.json({ error: "This activity is already open" }, { status: 409 });
    nextSource = reopenActivitySource(existing.source, existing.type);
    nextOccurredAt = plannedEpoch;
    nextSummary = `${subject}\n${notes}`;
    nextStatus = "scheduled";
  } else if (body.action === "cancel") {
    nextSource = existing.source.startsWith("cancelled:") ? existing.source : `cancelled:${existing.source}`;
    const retainedOutcome = body.outcome?.trim() || splitSummary(existing.summary).outcome;
    nextSummary = `${subject}\n${notes}${retainedOutcome ? `\nOutcome: ${retainedOutcome}` : ""}`;
    nextStatus = "cancelled";
  } else if (body.action === "reschedule") {
    const rescheduledAt = parseDate(body.rescheduledAt);
    if (!rescheduledAt || rescheduledAt.getTime() <= nowDate.getTime()) return Response.json({ error: "Choose a future date and time" }, { status: 422 });
    nextOccurredAt = Math.floor(rescheduledAt.getTime() / 1000);
    nextSource = `capture-scheduled:rescheduled:${plannedEpoch}:${existing.type}`;
    nextSummary = `${subject}\n${notes}`;
    nextStatus = "scheduled";
  } else {
    const outcome = body.action === "no-response" ? (body.outcome?.trim() || "No response") : body.outcome?.trim() ?? "";
    if (outcome.length < 2 || outcome.length > 5000) return Response.json({ error: "Record the outcome before closing" }, { status: 422 });
    const completedAt = parseDate(body.completedAt) ?? nowDate;
    if (completedAt.getTime() > nowDate.getTime() + 300_000) return Response.json({ error: "Choose a valid completed date and time" }, { status: 422 });
    nextOccurredAt = Math.floor(completedAt.getTime() / 1000);
    nextSource = `capture-completed:${plannedEpoch}:${body.action === "no-response" ? "no-response" : "completed"}:${originalActivitySource(existing.source)}`;
    nextSummary = `${subject}\n${notes}\nOutcome: ${outcome}`;
    nextStatus = body.action === "no-response" ? "no-response" : "completed";
  }

  let followUpId: string | null = null;
  const statements = [env.DB.prepare("UPDATE interactions SET occurred_at = ?, summary = ?, source = ?, updated_at = ? WHERE id = ? AND user_id = ? AND source = ? AND occurred_at = ?")
    .bind(nextOccurredAt, nextSummary, nextSource, now, id, profile.id, existing.source, existing.occurred_at)];
  if (body.followUpEnabled) {
    const followUpAt = parseDate(body.followUpAt);
    if (!body.followUpType || !kinds.has(body.followUpType as InteractionKind)) return Response.json({ error: "Choose a follow-up type" }, { status: 422 });
    if (!followUpAt || followUpAt.getTime() <= nowDate.getTime()) return Response.json({ error: "Choose a future follow-up date and time" }, { status: 422 });
    followUpId = `activity-followup-${id}`;
    const followUpSubject = body.followUpSubject?.trim() || `Follow up: ${subject}`;
    const followUpNotes = body.followUpNotes?.trim() || `Follow up on ${subject}`;
    statements.push(env.DB.prepare(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET type = excluded.type, occurred_at = excluded.occurred_at,
      summary = excluded.summary, source = excluded.source, updated_at = excluded.updated_at`)
      .bind(followUpId, existing.donor_id, profile.id, body.followUpType, Math.floor(followUpAt.getTime() / 1000), `${followUpSubject}\n${followUpNotes}`, `capture-scheduled:followup:${id}:${body.followUpType}`, now, now));
  }
  statements.push(env.DB.prepare("DELETE FROM recommendations WHERE id = ? AND user_id = ?").bind(`activity-${id}`, profile.id));
  const auditId = crypto.randomUUID();
  statements.push(env.DB.prepare(`INSERT INTO activity_status_audits (id, interaction_id, user_id, action, from_status, to_status, previous_source, next_source,
    previous_occurred_at, next_occurred_at, previous_summary, next_summary, follow_up_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(auditId, id, profile.id, body.action, currentStatus, nextStatus, existing.source, nextSource, existing.occurred_at, nextOccurredAt, existing.summary, nextSummary, followUpId, now));

  // Relationship Intelligence Phase 2 (see docs/AI-HANDOFF.md's
  // "Relationship Intelligence Phase 2" section). Two independent
  // concerns:
  //
  // 1. Cancellation invalidation (body.action === "cancel", REGARDLESS
  //    of currentStatus -- this route's own established convention
  //    already allows cancelling a previously-completed activity, not
  //    just a scheduled one: `nextSource` wraps a `cancelled:` prefix
  //    around whatever source was there before, including a
  //    `capture-completed:...` one, and activityStatus() resolves
  //    `cancelled:` before `capture-completed:`, so the result is
  //    unconditionally "cancelled" -- see
  //    lib/workspace/scheduled-activity.ts and the pre-existing
  //    `cancelled:${completedSource}` fixture in
  //    tests/activity-outcome.test.mjs). Traced (not inferred from the
  //    word "cancel" alone) against every downstream consumer: the
  //    donor's "Last Contact"/lastCompletedInteraction computation in
  //    lib/relationships/meeting-brief.ts explicitly excludes any
  //    interaction whose source matches `cancelled:%` (`AND i.source NOT
  //    LIKE 'cancelled:%'`) -- so a cancelled activity, even one that
  //    was previously completed and had its outcome accepted, no longer
  //    counts as real contact for relationship-recency purposes, even
  //    though the interaction row itself is preserved (never deleted)
  //    and still visible in the timeline, correctly labeled "cancelled"
  //    (see lib/relationships/unified-timeline.ts). This means
  //    cancellation genuinely INVALIDATES the source interaction as
  //    something that should still count as having happened -- so any
  //    CURRENT fact this interaction sourced must stop being current,
  //    exactly like the edit route's own archive/reassignment paths.
  //    planFactArchival() is a safe no-op when this interaction never
  //    had a current fact to begin with (nothing to cancel from a
  //    still-scheduled activity), so this call is unconditional on
  //    action === "cancel", never gated on currentStatus.
  // 2. Explicit-acceptance gate, UNCHANGED: only ever considered when
  //    this outcome genuinely closes the activity (`nextStatus`
  //    completed/no-response -- cancel/reschedule/reopen never reach
  //    THIS block), AND `body.acceptRelationshipSnapshot === true`. What
  //    changed in Phase 2 is what happens once both gates pass: instead
  //    of a bespoke CAS overwrite of donors.relationship_summary/
  //    institutional_memory with just this note's own text, the shared
  //    planFactAcceptance() pipeline (lib/relationships/fact-accept.ts)
  //    creates a durable, provenance-carrying fact (this interaction's
  //    own id + occurred_at) and resynthesizes the Snapshot from the
  //    donor's full current-fact set -- an accepted fact now ADDS to
  //    durable intelligence rather than replacing it. sourceInteractionId
  //    is this existing interaction's own `id` -- an outcome always
  //    attributes its fact to the activity being closed, never a
  //    different one.
  //
  // Both reach exactly one donor (`existing.donor_id`) regardless of
  // shared_activity_id linkage -- neither planFactAcceptance() nor
  // planFactArchival() has any shared-activity concept at all.
  if (body.action === "cancel") {
    const archival = await planFactArchival({ donorId: existing.donor_id, userId: profile.id, sourceInteractionId: id, now });
    statements.push(...archival.statements);
  }
  let relationshipStatementIndex = -1;
  if ((nextStatus === "completed" || nextStatus === "no-response") && body.acceptRelationshipSnapshot === true) {
    const kind = kinds.has(existing.type as InteractionKind) ? existing.type as InteractionKind : "note";
    const outcomeText = body.action === "no-response" ? (body.outcome?.trim() || "No response") : body.outcome?.trim() ?? "";
    const plan = await planFactAcceptance({
      donorId: existing.donor_id, userId: profile.id, sourceInteractionId: id, sourceInteractionOccurredAt: nextOccurredAt,
      noteText: `${notes}\nOutcome: ${outcomeText}`, kind, subject, now,
    });
    if (plan.relationshipStatementIndex >= 0) relationshipStatementIndex = statements.length + plan.relationshipStatementIndex;
    statements.push(...plan.statements);
  }

  let relationshipUpdated = false;
  try {
    const results = await env.DB.batch(statements) as unknown as Array<{ meta?: { changes?: number } }>;
    if ((results[0].meta?.changes ?? 0) === 0) return Response.json({ error: "This activity was updated elsewhere. Refresh and try again." }, { status: 409 });
    // Reports whether the relationship-snapshot write actually applied,
    // not merely whether it was attempted -- a stale compare-and-swap
    // (the donor's snapshot changed between page load and this submit)
    // fails closed with `changes: 0` here without failing the whole
    // request, since the activity itself still closed out correctly;
    // the client surfaces this honestly rather than claiming a write
    // that didn't happen.
    if (relationshipStatementIndex >= 0) relationshipUpdated = (results[relationshipStatementIndex]?.meta?.changes ?? 0) > 0;
  } catch (error) {
    logger.error("activity_outcome_update_failed", error, { interactionId: id, userId: profile.id, action: body.action });
    return Response.json({ error: "Activity changes could not be saved" }, { status: 500 });
  }
  return Response.json({ interactionId: id, status: nextStatus, auditId, followUpId, followUpHref: followUpId ? `/interactions/${encodeURIComponent(followUpId)}/edit` : null,
    activityHref: `/interactions/${encodeURIComponent(id)}/outcome`, relationshipUpdated,
    message: followUpId ? "Activity saved and follow-up scheduled." : "Activity updated.", databaseChanges: true });
}
