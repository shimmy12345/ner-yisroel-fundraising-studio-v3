import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { extractInteraction, type InteractionKind } from "../../../../../lib/capture/interaction";
import { isScheduledActivity } from "../../../../../lib/workspace/scheduled-activity";
import { logger } from "../../../../../lib/logger";

type InteractionRow = {
  id: string;
  donor_id: string;
  type: string;
  occurred_at: number;
  summary: string;
  source: string;
  created_at: number;
};

type OutcomeBody = {
  action?: "complete" | "cancel" | "reschedule" | "no-response";
  outcome?: string;
  completedAt?: string;
  followUp?: string;
  followUpAt?: string;
  rescheduledAt?: string;
};

const kinds = new Set<InteractionKind>(["call", "email", "meeting", "visit", "note", "personal"]);

function parseDate(value?: string) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

async function ownedScheduledActivity(id: string, userId: string) {
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
  const existing = await ownedScheduledActivity(id, profile.id);
  if (!existing) return Response.json({ error: "Activity not found" }, { status: 404 });
  if (!isScheduledActivity(existing.source, existing.occurred_at, existing.created_at)) {
    return Response.json({ error: "This activity is no longer open" }, { status: 409 });
  }

  const body = await request.json().catch(() => null) as OutcomeBody | null;
  if (!body?.action || !["complete", "cancel", "reschedule", "no-response"].includes(body.action)) {
    return Response.json({ error: "Choose an activity outcome" }, { status: 422 });
  }

  const nowDate = new Date();
  const now = Math.floor(nowDate.getTime() / 1000);
  if (body.action === "cancel") {
    try {
      await env.DB.batch([
        env.DB.prepare("UPDATE interactions SET source = ?, updated_at = ? WHERE id = ? AND user_id = ?")
          .bind(`cancelled:${existing.source}`, now, id, profile.id),
        env.DB.prepare("DELETE FROM recommendations WHERE id = ? AND user_id = ?").bind(`activity-${id}`, profile.id),
      ]);
    } catch (error) {
      logger.error("activity_outcome_cancel_failed", error, { interactionId: id, userId: profile.id });
      return Response.json({ error: "Activity could not be cancelled" }, { status: 500 });
    }
    return Response.json({ interactionId: id, status: "cancelled", databaseChanges: true });
  }

  if (body.action === "reschedule") {
    const rescheduledAt = parseDate(body.rescheduledAt);
    if (!rescheduledAt || rescheduledAt.getTime() <= nowDate.getTime()) {
      return Response.json({ error: "Choose a future date and time" }, { status: 422 });
    }
    const rescheduledEpoch = Math.floor(rescheduledAt.getTime() / 1000);
    try {
      await env.DB.prepare("UPDATE interactions SET occurred_at = ?, source = ?, updated_at = ? WHERE id = ? AND user_id = ?")
        .bind(rescheduledEpoch, `capture-scheduled:rescheduled:${existing.occurred_at}:${existing.type}`, now, id, profile.id).run();
    } catch (error) {
      logger.error("activity_outcome_reschedule_failed", error, { interactionId: id, userId: profile.id });
      return Response.json({ error: "Activity could not be rescheduled" }, { status: 500 });
    }
    return Response.json({ interactionId: id, status: "rescheduled", scheduledAt: rescheduledAt.toISOString(), databaseChanges: true });
  }

  const outcome = body.action === "no-response" ? "No response" : body.outcome?.trim() ?? "";
  if (outcome.length < 2 || outcome.length > 5000) return Response.json({ error: "Record the outcome before closing" }, { status: 422 });
  const completedAt = parseDate(body.completedAt) ?? nowDate;
  if (completedAt.getTime() < existing.created_at * 1000 || completedAt.getTime() > nowDate.getTime() + 300_000) {
    return Response.json({ error: "Choose a valid completed date and time" }, { status: 422 });
  }
  const followUp = body.followUp?.trim() ?? "";
  const followUpAt = followUp ? parseDate(body.followUpAt) : null;
  if (followUp && (followUp.length > 5000 || !followUpAt || followUpAt.getTime() <= nowDate.getTime())) {
    return Response.json({ error: "Choose a future follow-up date and time" }, { status: 422 });
  }

  const kind = kinds.has(existing.type as InteractionKind) ? existing.type as InteractionKind : "note";
  const [subject = "Interaction", ...noteParts] = existing.summary.split("\n");
  const originalNotes = noteParts.join("\n") || subject;
  const completedEpoch = Math.floor(completedAt.getTime() / 1000);
  const completedSource = `capture-completed:${existing.occurred_at}:${body.action === "no-response" ? "no-response" : "completed"}:${existing.source}`;
  const completedSummary = `${subject}\n${originalNotes}\nOutcome: ${outcome}`;
  const extracted = extractInteraction(`${originalNotes}\nOutcome: ${outcome}`, kind, subject);
  const statements = [
    env.DB.prepare("UPDATE interactions SET occurred_at = ?, summary = ?, source = ?, updated_at = ? WHERE id = ? AND user_id = ? AND source = ? AND occurred_at = ?")
      .bind(completedEpoch, completedSummary, completedSource, now, id, profile.id, existing.source, existing.occurred_at),
    env.DB.prepare("DELETE FROM recommendations WHERE id = ? AND user_id = ?").bind(`activity-${id}`, profile.id),
  ];

  const latestOther = await env.DB.prepare(`SELECT occurred_at FROM interactions WHERE donor_id = ? AND user_id = ? AND id != ?
    AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%'
    AND (source LIKE 'capture-completed:%' OR (source NOT LIKE 'capture-scheduled:%' AND occurred_at <= created_at))
    ORDER BY occurred_at DESC LIMIT 1`).bind(existing.donor_id, profile.id, id).first<{ occurred_at: number }>();
  if (!latestOther || completedEpoch >= latestOther.occurred_at) {
    statements.push(env.DB.prepare("UPDATE donors SET relationship_summary = ?, institutional_memory = ?, relationship_health = 86, updated_at = ? WHERE id = ? AND owner_user_id = ? AND data_source = 'live'")
      .bind(extracted.relationshipSummary, extracted.memory, now, existing.donor_id, profile.id));
  }

  let followUpId: string | null = null;
  if (followUp && followUpAt) {
    followUpId = `activity-followup-${id}`;
    const followUpEpoch = Math.floor(followUpAt.getTime() / 1000);
    statements.push(env.DB.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(followUpId, existing.donor_id, profile.id, kind, followUpEpoch, `Follow up: ${subject}\n${followUp}`, `capture-scheduled:followup:${id}:${kind}`, now, now));
  }

  try {
    const results = await env.DB.batch(statements) as unknown as Array<{ meta: { changes?: number } }>;
    if ((results[0].meta.changes ?? 0) === 0) return Response.json({ error: "This activity was already updated" }, { status: 409 });
  } catch (error) {
    logger.error("activity_outcome_close_failed", error, { interactionId: id, userId: profile.id });
    return Response.json({ error: "Activity could not be closed" }, { status: 500 });
  }
  logger.info("activity_outcome_closed", { interactionId: id, userId: profile.id, followUpCreated: Boolean(followUpId) });
  return Response.json({
    interactionId: id,
    status: body.action === "no-response" ? "no-response" : "completed",
    plannedAt: new Date(existing.occurred_at * 1000).toISOString(),
    completedAt: completedAt.toISOString(),
    followUpId,
    databaseChanges: true,
  });
}
