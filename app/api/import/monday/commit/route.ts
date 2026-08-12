import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { getDataMode } from "../../../../../lib/workspace/mode";
import { numericDonorCode } from "../../../../../lib/relationships/donor-identity";
import { classifyMondayDisposition } from "../../../../../lib/import/monday-classify";
import { mondayHistoricalContextId, mondayInteractionId, mondayRecommendationId, mondaySourceFingerprint } from "../../../../../lib/import/monday-fingerprint";
import { excelSerialToIsoDate } from "../../../../../lib/import/monday-workbook";
import { extractInteraction } from "../../../../../lib/capture/interaction";
import { logger } from "../../../../../lib/logger";

// Writes only what was explicitly, individually approved -- there is no
// bulk "confirm contact" path anywhere in this file, and no code path
// here ever touches gifts, giving_activities, or any row this import
// didn't itself create (every row this route can write carries a
// deterministic "monday-interaction-"/"monday-recommendation-"/
// "monday-context-" id, an ID space crypto.randomUUID() can never
// coincidentally produce, so an UPDATE here can only ever land on this
// import's own prior rows). confirm_contact is the one exception that
// touches donors: it feeds relationship_summary/institutional_memory
// through the exact same extractInteraction() pure function a normal
// capture-and-accept does (see app/api/interactions/route.ts), guarded so
// an old imported row can never overwrite a fresher genuine snapshot --
// never a Monday-specific write path, never anything gift/giving-related.
// Re-running with the same Monday-source identity (donor code + the
// subitem's own position + its own text + Monday's own due date --
// deliberately excluding whatever date the fundraiser confirms) always
// resolves to the same id, so a corrected date updates the existing row
// instead of duplicating it.
//
// save_historical_context is deliberately narrow: allowed only for
// confirm_contact_candidate/historical_planned/ambiguous rows (an
// allow-list, not a deny-list, so a future disposition value defaults to
// rejected rather than silently writable). donation_note and
// future_planned can never reach this branch. It never writes
// interactions or recommendations -- donor_historical_context.status is
// always 'unconfirmed', never a value that could be mistaken for a
// completed contact or an open reminder.

type Decision = {
  code?: string;
  subitemIndex?: number;
  text?: string;
  dueDateRaw?: string | null;
  action?: "confirm_contact" | "accept_future_planned" | "create_followup" | "save_historical_context";
  actualContactDate?: string;
  dueDate?: string;
};
type Body = { decisions?: Decision[] };
type DonorRow = { id: string; display_name: string; donor_code: string | null; external_id: string | null };

function parseDateToEpochSeconds(dateStr: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  // Calendar-date precision only, anchored to UTC noon -- avoids any
  // local-timezone rendering ever shifting a confirmed date to the
  // adjacent calendar day, the same anchoring convention this app
  // already uses for financial (calendar-only) dates.
  return Date.UTC(Number(y), Number(m) - 1, Number(d), 12, 0, 0) / 1000;
}

export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  if (mode !== "live") return Response.json({ error: "Historical import is only available in your live workspace." }, { status: 422 });

  const body = await request.json().catch(() => null) as Body | null;
  const decisions = body?.decisions;
  if (!decisions || !Array.isArray(decisions) || decisions.length === 0) return Response.json({ error: "No decisions were submitted." }, { status: 422 });

  const donorRows = await env.DB.prepare("SELECT id, display_name, donor_code, external_id FROM donors WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL").bind(profile.id).all<DonorRow>();
  const lookup = new Map<string, { id: string }>();
  for (const row of donorRows.results) {
    const code = numericDonorCode({ donorCode: row.donor_code, externalId: row.external_id });
    if (code) lookup.set(code, { id: row.id });
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const now = Math.floor(Date.now() / 1000);
  const statements = [];
  let confirmedContactCount = 0;
  let recommendationCount = 0;
  let historicalContextCount = 0;
  const rejected: Array<{ text: string | undefined; reason: string }> = [];
  // Tracks, within this single commit request, the latest occurred_at a
  // confirmed Monday contact has already claimed per donor -- a D1 read
  // can't see another statement queued earlier in the same batch that
  // hasn't executed yet, so two confirmed rows for the same donor in one
  // request must still be compared against each other, not just against
  // what's already on disk.
  const donorLatestConfirmedInBatch = new Map<string, number>();
  const HISTORICAL_CONTEXT_ALLOWED_DISPOSITIONS = new Set(["confirm_contact_candidate", "historical_planned", "ambiguous"]);

  for (const decision of decisions) {
    const code = decision.code?.trim();
    const text = decision.text?.trim();
    const subitemIndex = decision.subitemIndex;
    if (!code || !text || typeof subitemIndex !== "number" || !decision.action) { rejected.push({ text, reason: "Incomplete decision" }); continue; }
    const donor = lookup.get(code);
    if (!donor) { rejected.push({ text, reason: "Donor is not matched in this workspace" }); continue; }

    // Re-derive the disposition server-side rather than trust the
    // client's label -- a request can never approve an action the
    // classifier itself wouldn't have proposed for this exact row.
    const dueDateIso = excelSerialToIsoDate(decision.dueDateRaw ?? null);
    const disposition = classifyMondayDisposition(text, dueDateIso, todayIso);
    const fingerprint = mondaySourceFingerprint({ donorCode: code, subitemIndex, text, dueDateRaw: decision.dueDateRaw ?? null });

    if (decision.action === "confirm_contact") {
      if (disposition !== "confirm_contact_candidate") { rejected.push({ text, reason: "This row is not a likely completed contact" }); continue; }
      if (!decision.actualContactDate) { rejected.push({ text, reason: "An actual contact date is required" }); continue; }
      const occurredAt = parseDateToEpochSeconds(decision.actualContactDate);
      if (occurredAt === null) { rejected.push({ text, reason: "Invalid contact date" }); continue; }
      const id = mondayInteractionId(fingerprint);
      const summary = `${text}\nImported from Monday.com pipeline export. Source due date: ${dueDateIso ?? "not recorded"}.`;
      const existing = await env.DB.prepare("SELECT id FROM interactions WHERE id=? AND user_id=?").bind(id, profile.id).first<{ id: string }>();
      if (existing) {
        statements.push(env.DB.prepare("UPDATE interactions SET occurred_at=?, occurred_at_date_only=1, summary=?, updated_at=? WHERE id=? AND user_id=?").bind(occurredAt, summary, now, id, profile.id));
      } else {
        statements.push(env.DB.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, occurred_at_date_only, summary, source, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?,?)")
          .bind(id, donor.id, profile.id, "note", occurredAt, summary, "import-monday:confirmed", now, now));
      }
      confirmedContactCount++;

      // A row explicitly confirmed here is no longer uncertain -- it must
      // satisfy the same completed-interaction contract a normal capture
      // does, including feeding the Relationship Snapshot the same way
      // app/api/interactions/route.ts does when its own AI-suggested
      // snapshot is accepted. Only update the snapshot when this is
      // actually the donor's most recent completed contact, so importing
      // an old historical row can never regress a fresher, genuinely
      // captured one.
      const latestOtherRow = await env.DB.prepare(
        `SELECT MAX(occurred_at) AS value FROM interactions WHERE donor_id=? AND user_id=? AND id!=? AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%' AND (source LIKE 'capture-completed:%' OR (source NOT LIKE 'capture-scheduled:%' AND occurred_at <= created_at))`,
      ).bind(donor.id, profile.id, id).first<{ value: number | null }>();
      const latestOther = Math.max(latestOtherRow?.value ?? 0, donorLatestConfirmedInBatch.get(donor.id) ?? 0);
      if (occurredAt >= latestOther) {
        const extracted = extractInteraction(text, "note");
        statements.push(env.DB.prepare("UPDATE donors SET relationship_summary=?, institutional_memory=?, relationship_health=?, updated_at=? WHERE id=? AND owner_user_id=? AND data_source='live'")
          .bind(extracted.relationshipSummary, extracted.memory, 86, now, donor.id, profile.id));
      }
      donorLatestConfirmedInBatch.set(donor.id, Math.max(occurredAt, donorLatestConfirmedInBatch.get(donor.id) ?? 0));
    } else if (decision.action === "accept_future_planned" || decision.action === "create_followup") {
      if (decision.action === "accept_future_planned" && disposition !== "future_planned") { rejected.push({ text, reason: "This row is not a future planned-action candidate" }); continue; }
      if (decision.action === "create_followup" && disposition !== "historical_planned") { rejected.push({ text, reason: "Create-follow-up only applies to historical/undated planned actions" }); continue; }
      if (!decision.dueDate) { rejected.push({ text, reason: "A due date is required" }); continue; }
      const dueAt = parseDateToEpochSeconds(decision.dueDate);
      if (dueAt === null) { rejected.push({ text, reason: "Invalid due date" }); continue; }
      const id = mondayRecommendationId(fingerprint);
      const reason = `Historical Monday task: "${text}" (originally due ${dueDateIso ?? "no date recorded"}).`;
      const existing = await env.DB.prepare("SELECT id FROM recommendations WHERE id=? AND user_id=?").bind(id, profile.id).first<{ id: string }>();
      if (existing) {
        statements.push(env.DB.prepare("UPDATE recommendations SET action=?, reason=?, due_at=?, due_at_date_only=1, status='open', updated_at=? WHERE id=? AND user_id=?").bind(text, reason, dueAt, now, id, profile.id));
      } else {
        statements.push(env.DB.prepare("INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, due_at_date_only, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)")
          .bind(id, donor.id, profile.id, text, reason, 40, "open", dueAt, now, now));
      }
      recommendationCount++;
    } else if (decision.action === "save_historical_context") {
      if (!HISTORICAL_CONTEXT_ALLOWED_DISPOSITIONS.has(disposition)) { rejected.push({ text, reason: "This row cannot be saved as historical context" }); continue; }
      const id = mondayHistoricalContextId(fingerprint);
      const sourceDate = dueDateIso ? parseDateToEpochSeconds(dueDateIso) : null;
      const existing = await env.DB.prepare("SELECT id FROM donor_historical_context WHERE id=? AND user_id=?").bind(id, profile.id).first<{ id: string }>();
      if (existing) {
        statements.push(env.DB.prepare("UPDATE donor_historical_context SET text=?, source_date=?, classification=?, updated_at=? WHERE id=? AND user_id=?").bind(text, sourceDate, disposition, now, id, profile.id));
      } else {
        statements.push(env.DB.prepare("INSERT INTO donor_historical_context (id, donor_id, user_id, text, source_date, classification, source, fingerprint, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
          .bind(id, donor.id, profile.id, text, sourceDate, disposition, "import-monday", fingerprint, "unconfirmed", now, now));
      }
      historicalContextCount++;
    } else {
      rejected.push({ text, reason: "Unsupported action" });
    }
  }

  if (statements.length === 0) return Response.json({ confirmedContactCount: 0, recommendationCount: 0, historicalContextCount: 0, rejected });

  try {
    await env.DB.batch(statements);
  } catch (error) {
    logger.error("monday_import_commit_failed", error, { userId: profile.id });
    return Response.json({ error: "The import could not be saved. No rows were written." }, { status: 500 });
  }
  logger.info("monday_import_committed", { userId: profile.id, confirmedContactCount, recommendationCount, historicalContextCount, rejectedCount: rejected.length });
  return Response.json({ confirmedContactCount, recommendationCount, historicalContextCount, rejected });
}
